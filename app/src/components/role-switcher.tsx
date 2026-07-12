import { Link, useLocation } from "@tanstack/react-router";
import { type ElementType } from "react";
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

export type AppRole = "admin" | "user";

const roleMeta: Record<
  AppRole,
  {
    url: string;
    logo: ElementType;
    name: () => string;
    description: () => string;
  }
> = {
  user: {
    url: "/dashboard",
    logo: UserFill,
    name: () => m.component_role_switcher_role_user(),
    description: () => m.component_role_switcher_role_user_description(),
  },
  admin: {
    url: "/admin",
    logo: UserSecurityFill,
    name: () => m.component_role_switcher_role_admin(),
    description: () => m.component_role_switcher_role_admin_description(),
  },
};

export interface RoleSwitcherProps {
  role: AppRole;
  isAdmin: boolean;
}

export function RoleSwitcher({ role, isAdmin }: RoleSwitcherProps) {
  const { pathname } = useLocation();

  const currentRole: AppRole = pathname.startsWith("/admin") ? "admin" : role;

  const availableRoles: AppRole[] = isAdmin ? ["user", "admin"] : ["user"];

  const { name: currentRoleName, logo: CurrentLogo } = roleMeta[currentRole];

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!isAdmin}
            render={
              <SidebarMenuButton
                className={cn(
                  "data-popup-open:text-sidebar-accent-foregroun data-popup-open:bg-sidebar-accent",
                  "group-data-[collapsible=icon]:p-0!",
                  "disabled:opacity-100",
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
                  <p>{currentRoleName()}</p>
                </div>

                {isAdmin && <DownLine className="ml-auto" />}
              </SidebarMenuButton>
            }
          />

          {isAdmin && (
            <DropdownMenuContent
              className="w-60 rounded-lg"
              align="start"
              sideOffset={4}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {m.component_role_switcher_title()}
                </DropdownMenuLabel>

                {availableRoles.map((availableRole) => {
                  const {
                    name,
                    description,
                    url,
                    logo: Logo,
                  } = roleMeta[availableRole];

                  return (
                    <Tooltip key={availableRole}>
                      <TooltipTrigger
                        className="gap-2 p-2"
                        render={<DropdownMenuItem render={<Link to={url} />} />}
                      >
                        <div className="flex size-6 items-center justify-center rounded-md border">
                          <Logo className="size-3.5 shrink-0" />
                        </div>

                        <p className="flex flex-1 items-center text-left text-sm leading-tight">
                          <span>{name()}</span>

                          {availableRole === currentRole && (
                            <CheckLine className="ml-auto" />
                          )}
                        </p>
                      </TooltipTrigger>

                      <TooltipPopup className="max-w-xs">
                        <p className="text-xs text-muted-foreground">
                          {description()}
                        </p>
                      </TooltipPopup>
                    </Tooltip>
                  );
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
