"use client";

import { cn } from "@terrablox/ui/lib/utils";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { type Breadcrumb, PageHeader } from "@/components/layout/page-header";

/**
 * The app shell with a placeholder body.
 *
 * A route-level `loading.tsx` and the wait a page still has for its own data
 * are two phases of one navigation. Rendering both through this keeps the
 * sidebar and header in place, so the phases read as continued loading rather
 * than as the page reloading twice.
 */
export function PageSkeleton({
  breadcrumbs,
  loadingTitle = false,
  mainClassName,
  children,
}: {
  breadcrumbs: Breadcrumb[];
  /** Placeholder for the page title, for routes whose name is itself data. */
  loadingTitle?: boolean;
  mainClassName?: string;
  children: ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={breadcrumbs} loading={loadingTitle} />
        <main className={cn("flex-1 space-y-4 p-6", mainClassName)}>
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Placeholder for the card grids the list pages are built from. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, index) => index).map((index) => (
        <Skeleton className="h-36 w-full" key={index} />
      ))}
    </div>
  );
}

/** Placeholder for the single-column settings screens. */
export function SettingsSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-6">
      {Array.from({ length: count }, (_, index) => index).map((index) => (
        <Skeleton className="h-48 w-full" key={index} />
      ))}
    </div>
  );
}
