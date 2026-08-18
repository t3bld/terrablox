"use client";

import { Button } from "@terrablox/ui/button";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";

/** Keeps a failed load inside the app shell instead of the default error page. */
export default function ModuleDetailError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          breadcrumbs={[
            { label: "Modules", href: "/modules" },
            { label: "Module" },
          ]}
        />

        <main className="space-y-4 p-4">
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {error.message || "Failed to load module"}
          </div>

          <Button onClick={reset} size="sm" variant="outline">
            Try again
          </Button>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
