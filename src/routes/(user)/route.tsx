import { createFileRoute, redirect } from "@tanstack/react-router";

import { getSession } from "@/lib/auth";

export const Route = createFileRoute("/(user)")({
  beforeLoad: async () => {
    const session = await getSession();

    if (!session) {
      throw redirect({
        to: "/auth/login",
      });
    }

    return {
      user: session.user,
    };
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/(admin)"!</div>;
}
