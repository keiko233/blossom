import { createFileRoute, Link } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  buildTopologyList,
  visibleSelection,
  type TopologyInput,
  type TopologySelection,
} from "@/lib/networking-topology";
import { m } from "@/paraglide/messages";

import { NetworkingSection } from "./_modules/networking-badges";
import { NetworkingRollouts } from "./_modules/networking-rollouts";
import { TopologyCanvas } from "./_modules/topology-canvas";
import { TopologyInspector } from "./_modules/topology-inspector";
import { TopologyList } from "./_modules/topology-list";
import { useNetworkingWorkspace } from "./_modules/use-networking-workspace";

export const Route = createFileRoute("/(admin)/admin/networking/topology")({
  staticData: {
    crumb: () => m.admin_workspace_networking_topology(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const { data, isPending, isError, refetch } = useNetworkingWorkspace();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<TopologySelection | null>(null);

  if (isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex flex-col gap-3 p-4 md:p-6">
        <p className="text-sm text-destructive">
          {m.admin_networking_load_error()}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {m.admin_networking_action_retry()}
        </Button>
      </div>
    );
  }

  const input: TopologyInput = {
    servers: data.servers.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
    })),
    peerInbounds: data.peerInbounds.map((row) => ({
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      protocol: row.protocol,
    })),
    links: data.links.map((row) => ({
      id: row.id,
      sourceServerId: row.sourceServerId,
      destinationInboundId: row.destinationInboundId,
      phase: row.phase,
      health: row.health,
    })),
  };
  const list = buildTopologyList(input, query);
  const visible = visibleSelection(list.servers, selection);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageHeaderTitle>
            {m.admin_workspace_networking_topology()}
          </PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_networking_topology_description()}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/admin/networking/links" />}
        >
          {m.admin_networking_action_add_link()}
        </Button>
      </PageHeader>

      {data.activationEnabled ? null : (
        <Alert variant="info" data-slot="networking-activation-alert">
          <AlertTitle>
            {m.admin_networking_activation_disabled_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_networking_activation_disabled_description()}
          </AlertDescription>
        </Alert>
      )}

      {data.servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_networking_no_servers()}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="relative max-w-md">
              <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                className="ps-9"
                aria-label={m.admin_networking_topology_search_label()}
                placeholder={m.admin_networking_topology_search_placeholder()}
                value={query}
                onValueChange={(value) => setQuery(value)}
              />
            </div>

            <NetworkingSection
              title={m.admin_networking_topology_canvas_section()}
              description={m.admin_networking_topology_canvas_description()}
            >
              <TopologyCanvas
                list={list}
                selection={visible}
                onSelection={setSelection}
              />
            </NetworkingSection>

            <NetworkingSection
              title={m.admin_networking_topology_list_section()}
              description={m.admin_networking_topology_list_section_description()}
            >
              <TopologyList
                list={list}
                filtered={query.trim().length > 0}
                selection={visible}
                onSelectionChange={setSelection}
              />
            </NetworkingSection>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <NetworkingSection
              title={m.admin_networking_topology_inspector_label()}
            >
              <TopologyInspector
                selection={visible}
                list={list}
                workspace={data}
              />
            </NetworkingSection>

            <NetworkingRollouts
              rollouts={data.rollouts}
              activationEnabled={data.activationEnabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}
