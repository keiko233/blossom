import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { m } from "@/paraglide/messages";
import type { ServerListItem } from "@/query/servers";

import { useServerActions } from "./use-server-actions";

export interface ServerActionsMenuProps {
  server: ServerListItem;
}

export function ServerActionsMenu({
  server,
}: ServerActionsMenuProps): React.ReactElement {
  const navigate = useNavigate();
  const { isBusy, copyAgentInfo, requestDelete } = useServerActions(server);

  const openConnection = () =>
    void navigate({
      to: "/admin/servers/$serverId/connection",
      params: { serverId: server.id },
    });

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            loading={isBusy}
            size="icon-sm"
            variant="outline"
            aria-label={m.admin_proxies_servers_workspace_actions_label()}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void copyAgentInfo()}>
          {m.admin_proxies_servers_action_copy_agent()}
        </MenuItem>
        <MenuItem onClick={openConnection}>
          {m.admin_proxies_servers_action_connection()}
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => void requestDelete()}>
          {m.admin_proxies_servers_action_delete()}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
