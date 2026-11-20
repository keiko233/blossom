import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/(admin)/admin/networking/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/networking/topology" });
  },
});
