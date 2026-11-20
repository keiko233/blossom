import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/(admin)/admin/operations/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/operations/traffic" });
  },
});
