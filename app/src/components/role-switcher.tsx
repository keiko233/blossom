import { Link, useLocation } from "@tanstack/react-router";
import { useMemo, type ElementType } from "react";
import DownLine from "~icons/mingcute/down-line";
import UserFill from "~icons/mingcute/user-2-fill";
import UserSecurityFill from "~icons/mingcute/user-security-fill";

import { Marquee } from "@/components/ui/marquee";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

enum Role {
  Admin = "admin",
  User = "user",
}

const roles = {
  [Role.User]: {
    name: m.component_role_switcher_role_user(),
    description: m.component_role_switcher_role_user_description(),
    url: "/dashboard",
    logo: UserFill,
  },
  [Role.Admin]: {
    name: m.component_role_switcher_role_admin(),
    description: m.component_role_switcher_role_admin_description(),
    url: "/admin",
    logo: UserSecurityFill,
  },
} satisfies Record<
  Role,
  {
    name: string;
    description: string;
    url: string;
    logo: ElementType;
  }
>;

export function RoleSwitcher() {
  const { isMobile } = useSidebar();

  const { pathname } = useLocation();

  const currentRole = useMemo(() => {
    if (pathname.startsWith("/admin")) {
      return Role.Admin;
    }

    return Role.User;
  }, [pathname]);

  const {
    name: currentRoleName,
    description: currentRoleDescription,
    logo: CurrentLogo,
  } = roles[currentRole];

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              >
                <div
                  className={cn(
                    "flex aspect-square size-8 items-center justify-center rounded-lg",
                    "bg-sidebar-primary text-sidebar-primary-foreground",
                  )}
                >
                  <CurrentLogo className="size-4" />
                </div>

                <div className="grid flex-1 text-left text-sm leading-tight">
                  <p>{currentRoleName}</p>
                  <Marquee className="py-0 text-xs text-muted-foreground">
                    {currentRoleDescription}
                  </Marquee>
                </div>

                <DownLine className="ml-auto" />
              </SidebarMenuButton>
            }
          />

          <DropdownMenuContent
            className="w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {m.component_role_switcher_title()}
              </DropdownMenuLabel>

              {Object.values(roles).map(
                ({ name, description, url, logo: Logo }) => (
                  <DropdownMenuItem
                    key={name}
                    className="gap-2 p-2"
                    render={
                      <Link to={url}>
                        <div className="flex size-6 items-center justify-center rounded-md border">
                          <Logo className="size-3.5 shrink-0" />
                        </div>

                        <div className="grid flex-1 text-left text-sm leading-tight">
                          <p>{name}</p>
                          <Marquee className="py-0 text-xs text-muted-foreground">
                            {description}
                          </Marquee>
                        </div>
                      </Link>
                    }
                  />
                ),
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
