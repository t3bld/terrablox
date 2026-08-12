import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";

/**
 * Route-level fallback.
 *
 * Opening a project reads the repository over the network, which takes a
 * moment. Without this the previous page would stay frozen on screen and the
 * app would look stuck.
 */
export default function ProjectDetailLoading() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        <PageHeader
          loading
          breadcrumbs={[
            { label: "Projects", href: "/projects" },
            { label: "Project" },
          ]}
        />

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 space-y-2 border-r p-3 md:block">
            <Skeleton className="h-9 w-full" />
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </aside>

          <main className="min-w-0 flex-1 p-3">
            <Skeleton className="h-full w-full" />
          </main>

          <aside className="hidden w-96 shrink-0 space-y-3 border-l p-3 lg:block">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </aside>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
