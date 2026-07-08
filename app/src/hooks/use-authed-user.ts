import { Route as RootRoute } from "@/routes/(admin)/route";

export function useAuthedUser() {
  const { user } = RootRoute.useRouteContext();

  return user;
}
