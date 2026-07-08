import { Link, useLocation } from "@tanstack/react-router";
import { useMemo, type ElementType } from "react";
import CheckLine from "~icons/mingcute/check-line";
import DownLine from "~icons/mingcute/down-line";
import UserFill from "~icons/mingcute/user-2-fill";
import UserSecurityFill from "~icons/mingcute/user-security-fill";

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
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

enum Role {
  Admin = "admin",
  User = "user",
}

const roleMeta = {
  [Role.User]: {
    url: "/dashboard",
    logo: UserFill,
  },
  [Role.Admin]: {
    url: "/admin",
    logo: UserSecurityFill,
  },
} satisfies Record<
  Role,
  {
    url: string;
    logo: ElementType;
  }
>;

export function RoleSwitcher() {
  const { pathname } = useLocation();
  const roles = {
    [Role.User]: {
      ...roleMeta[Role.User],
      name: m.component_role_switcher_role_user(),
      description: m.component_role_switcher_role_user_description(),
    },
    [Role.Admin]: {
      ...roleMeta[Role.Admin],
      name: m.component_role_switcher_role_admin(),
      description: m.component_role_switcher_role_admin_description(),
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

  const currentRole = useMemo(() => {
    if (pathname.startsWith("/admin")) {
      return Role.Admin;
    }

    return Role.User;
  }, [pathname]);

  const { name: currentRoleName, logo: CurrentLogo } = roles[currentRole];

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                className={cn(
                  "data-popup-open:text-sidebar-accent-foregroun data-popup-open:bg-sidebar-accent",
                  "group-data-[collapsible=icon]:p-0!",
                )}
              >
                <div
                  className={cn(
                    "flex aspect-square size-6 items-center justify-center rounded-md",
                    "transform bg-sidebar-primary text-sidebar-primary-foreground transition-all duration-300",
                    "group-data-[collapsible=icon]:size-8",
                  )}
                >
                  <CurrentLogo className="size-4" />
                </div>

                <div className="grid flex-1 text-left text-sm leading-tight font-bold">
                  <p>{currentRoleName}</p>
                </div>

                <DownLine className="ml-auto" />
              </SidebarMenuButton>
            }
          />

          <DropdownMenuContent
            className="w-60 rounded-lg"
            align="start"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {m.component_role_switcher_title()}
              </DropdownMenuLabel>

              {Object.entries(roles).map(
                ([role, { name, description, url, logo: Logo }]) => (
                  <Tooltip key={role}>
                    <TooltipTrigger
                      className="gap-2 p-2"
                      render={<DropdownMenuItem render={<Link to={url} />} />}
                    >
                      <div className="flex size-6 items-center justify-center rounded-md border">
                        <Logo className="size-3.5 shrink-0" />
                      </div>

                      <p className="flex flex-1 items-center text-left text-sm leading-tight">
                        <span>{name}</span>

                        {role === currentRole && (
                          <CheckLine className="ml-auto" />
                        )}
                      </p>
                    </TooltipTrigger>

                    <TooltipPopup className="max-w-xs">
                      <p className="text-xs text-muted-foreground">
                        {description}
                      </p>
                    </TooltipPopup>
                  </Tooltip>
                ),
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
