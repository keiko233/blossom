import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/(admin)/admin/servers/$serverId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/admin/servers/$serverId/overview",
      params,
    });
  },
});
