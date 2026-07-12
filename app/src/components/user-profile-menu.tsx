import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "tanstack-theme-kit";
import LogoutLine from "~icons/majesticons/logout-line";
import MenuLine from "~icons/mingcute/menu-line";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { useLockFn } from "@/hooks/use-lock-fn";
import { signOut, type SessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { getLocale, locales, setLocale } from "@/paraglide/runtime";

import { SidebarMenuButton } from "./ui/sidebar";

const ThemeMenu = () => {
  const { theme, setTheme } = useTheme();

  return (
    <MenuSub>
      <MenuSubTrigger>{m.component_user_profile_menu_theme()}</MenuSubTrigger>

      <MenuSubPopup>
        <MenuRadioGroup
          value={theme === "auto" ? "system" : theme}
          onValueChange={setTheme}
        >
          <MenuRadioItem value="dark">
            {m.component_user_profile_menu_theme_dark()}
          </MenuRadioItem>

          <MenuRadioItem value="light">
            {m.component_user_profile_menu_theme_light()}
          </MenuRadioItem>

          <MenuRadioItem value="system">
            {m.component_user_profile_menu_theme_system()}
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
};

const LanguageMenu = () => {
  const currentLocale = getLocale();

  return (
    <MenuSub>
      <MenuSubTrigger>
        {m.component_user_profile_menu_language()}
      </MenuSubTrigger>

      <MenuSubPopup>
        <MenuRadioGroup
          value={currentLocale}
          onValueChange={(locale) => {
            setLocale(locale);
          }}
        >
          {locales.map((locale) => (
            <MenuRadioItem key={locale} value={locale}>
              {m.language(undefined, {
                locale,
              })}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
};

const LogoutMenuItem = () => {
  const navigate = useNavigate();

  const handleLogout = useLockFn(async () => {
    await signOut();

    await navigate({
      to: "/dashboard",
      replace: true,
    });
  });

  return (
    <MenuItem variant="destructive" onClick={handleLogout}>
      <LogoutLine aria-hidden="true" />
      <span>{m.component_user_profile_menu_logout()}</span>
    </MenuItem>
  );
};

export interface UserProfileMenuProps {
  user: SessionUser;
}

export function UserProfileMenu({ user }: UserProfileMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            className={cn(
              "data-popup-open:text-sidebar-accent-foregroun data-popup-open:bg-sidebar-accent",
              "group-data-[collapsible=icon]:p-1!",
            )}
          />
        }
      >
        <Avatar className="size-6">
          <AvatarImage alt={user.name} src={user?.image || undefined} />
          <AvatarFallback>{user.name}</AvatarFallback>
        </Avatar>

        <div className="grid flex-1 text-left text-sm leading-tight font-bold">
          <p>{user.name}</p>
        </div>

        <MenuLine className="ml-auto" />
      </MenuTrigger>

      <MenuPopup align="end">
        <ThemeMenu />
        <LanguageMenu />

        <MenuSeparator />

        <LogoutMenuItem />
      </MenuPopup>
    </Menu>
  );
}
