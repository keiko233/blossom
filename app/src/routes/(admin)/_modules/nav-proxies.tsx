import { Link, useLocation } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import Network from "~icons/carbon/network-1";
import DownLine from "~icons/mingcute/down-line";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { m } from "@/paraglide/messages";

const items = [
  {
    name: m.admin_nav_proxies_item_servers(),
    url: "/admin/proxies/servers",
  },
  {
    name: m.admin_nav_proxies_item_nodes(),
    url: "/admin/proxies/nodes",
  },
  {
    name: m.admin_nav_proxies_item_groups(),
    url: "/admin/proxies/groups",
  },
  {
    name: m.admin_nav_proxies_item_rules(),
    url: "/admin/proxies/rules",
  },
] satisfies Array<{
  name: string;
  url: ComponentProps<typeof Link>["to"];
}>;

export function NavProxies() {
  const { pathname } = useLocation();

  return (
    <Collapsible
      defaultOpen={items.some((item) => pathname.startsWith(item.url))}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger
          render={
            <SidebarMenuButton tooltip={m.admin_nav_proxies_title()}>
              <Network />
              <span>{m.admin_nav_proxies_title()}</span>
              <DownLine className="ml-auto" />
            </SidebarMenuButton>
          }
        />

        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((subItem) => (
              <SidebarMenuSubItem key={subItem.name}>
                <SidebarMenuSubButton
                  isActive={pathname.startsWith(subItem.url)}
                  render={
                    <Link to={subItem.url}>
                      <span>{subItem.name}</span>
                    </Link>
                  }
                />
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );

  // return (
  //   <SidebarGroup className="group-data-[collapsible=icon]:hidden">
  //     <SidebarGroupLabel>{m.admin_nav_proxies_title()}</SidebarGroupLabel>

  //     <SidebarMenu>
  //       {items.map((item) => (
  //         <SidebarMenuItem key={item.name}>
  //           <SidebarMenuButton
  //             render={
  //               <Link to={item.url}>
  //                 <Network />
  //                 <span>{item.name}</span>
  //               </Link>
  //             }
  //           />

  //           <DropdownMenu>
  //             <DropdownMenuTrigger
  //               render={
  //                 <SidebarMenuAction showOnHover>
  //                   <DownLine />
  //                   <span className="sr-only">More</span>
  //                 </SidebarMenuAction>
  //               }
  //             />

  //             <DropdownMenuContent
  //               className="w-48 rounded-lg"
  //               side={isMobile ? "bottom" : "right"}
  //               align={isMobile ? "end" : "start"}
  //             >
  //               <DropdownMenuItem>
  //                 <Folder className="text-muted-foreground" />
  //                 <span>View Project</span>
  //               </DropdownMenuItem>
  //               <DropdownMenuItem>
  //                 <Forward className="text-muted-foreground" />
  //                 <span>Share Project</span>
  //               </DropdownMenuItem>
  //               <DropdownMenuSeparator />
  //               <DropdownMenuItem>
  //                 <Trash2 className="text-muted-foreground" />
  //                 <span>Delete Project</span>
  //               </DropdownMenuItem>
  //             </DropdownMenuContent>
  //           </DropdownMenu>
  //         </SidebarMenuItem>
  //       ))}
  //       <SidebarMenuItem>
  //         <SidebarMenuButton className="text-sidebar-foreground/70">
  //           <MoreHorizontal className="text-sidebar-foreground/70" />
  //           <span>More</span>
  //         </SidebarMenuButton>
  //       </SidebarMenuItem>
  //     </SidebarMenu>
  //   </SidebarGroup>
  // );
}
