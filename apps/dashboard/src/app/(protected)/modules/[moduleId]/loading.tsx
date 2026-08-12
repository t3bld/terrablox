import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import { ModuleDetailSkeleton } from "@/components/module-detail/detail-skeleton";

/**
 * Shown while the detail route segment is still being fetched. Without it the
 * previous page stays frozen on screen for the whole navigation, which reads
 * as an unresponsive click.
 */
export default function ModuleDetailLoading() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          loading
          breadcrumbs={[
            { label: "Modules", href: "/modules" },
            { label: "Module" },
          ]}
        />

        <main className="space-y-4 p-4">
          <ModuleDetailSkeleton />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
