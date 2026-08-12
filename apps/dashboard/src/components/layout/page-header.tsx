"use client";

import { Separator } from "@terrablox/ui/separator";
import { SidebarTrigger } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import Link from "next/link";
import type { ReactNode } from "react";

export interface Breadcrumb {
  label: string;
  /** Omitted on the last entry, which is the page you are already on. */
  href?: string;
}

interface PageHeaderProps {
  breadcrumbs: Breadcrumb[];
  /** Muted detail next to the title, e.g. the repository a project points at. */
  meta?: ReactNode;
  /** Buttons and menus, pushed to the right edge. */
  actions?: ReactNode;
  /** Shows a placeholder for the current page's name while it loads. */
  loading?: boolean;
}

/**
 * The header every page in the app shell wears.
 *
 * It exists so headers cannot drift apart: the sidebar toggle, the height, the
 * breadcrumb trail and the position of the actions are decided once here rather
 * than re-invented per page. Add a variant here before adding one in a page.
 */
export function PageHeader({
  breadcrumbs,
  meta,
  actions,
  loading = false,
}: PageHeaderProps) {
  const trail = breadcrumbs.slice(0, -1);
  const current = breadcrumbs[breadcrumbs.length - 1];

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      {/* Desktop toggles the sidebar from inside the sidebar. On mobile it is an
          overlay, so it cannot hold its own way of being opened. */}
      <SidebarTrigger className="-ml-1 md:hidden" />
      <Separator orientation="vertical" className="mr-2 h-4 md:hidden" />

      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-2">
          {trail.map((crumb) => (
            <li key={crumb.label} className="flex shrink-0 items-center gap-2">
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {crumb.label}
                </span>
              )}
              <span className="text-muted-foreground/60">/</span>
            </li>
          ))}

          <li className="min-w-0">
            {loading ? (
              <Skeleton className="h-5 w-40" />
            ) : (
              <h1 className="truncate text-lg font-semibold">
                {current?.label}
              </h1>
            )}
          </li>
        </ol>
      </nav>

      {meta ? (
        <div className="ml-2 hidden min-w-0 items-center gap-1 text-xs text-muted-foreground md:flex">
          {meta}
        </div>
      ) : null}

      {actions ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
