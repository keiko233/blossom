import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/(admin)/admin/access/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/access/users" });
  },
});
