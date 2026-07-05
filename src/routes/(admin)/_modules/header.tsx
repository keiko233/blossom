import { useMatches } from "@tanstack/react-router";
import { Fragment, type ComponentProps, type PropsWithChildren } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function AdminHeader({ children }: PropsWithChildren) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />

        <Separator orientation="vertical" className="h-4" />

        {children}
      </div>
    </header>
  );
}

/**
 * Breadcrumb built automatically from the matched routes' `staticData.crumb`.
 * Add `staticData: { crumb: () => m.some_key() }` to a route to make it show up
 * here — no manual wiring needed. The last crumb renders as the current page,
 * the rest as links to their own pathname.
 */
export function AutoBreadcrumb(props: ComponentProps<typeof BreadcrumbList>) {
  const matches = useMatches();

  const crumbs = matches
    .filter((match) => match.staticData.crumb)
    .map((match) => ({
      pathname: match.pathname,
      title: match.staticData.crumb?.(),
    }));

  return (
    <Breadcrumb>
      <BreadcrumbList {...props}>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;

          return (
            <Fragment key={crumb.pathname}>
              <BreadcrumbItem
                className={isLast ? undefined : "hidden md:block"}
              >
                {isLast ? (
                  <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink to={crumb.pathname}>
                    {crumb.title}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>

              {!isLast && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
