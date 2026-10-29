"use client";

import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import { McpSettings } from "@/components/mcp/mcp-settings";

/**
 * MCP access, on its own screen.
 *
 * Its own page rather than a card under Account, because it is not a fact about the person
 * — it is a set of credentials, a list to audit, and three client configurations. On the
 * account screen it was one card sharing a row with a profile and a GitHub link, and every
 * config block in it had to scroll.
 *
 * `/mcp` needs no entry in the middleware's protected paths: `isProtectedPath` treats
 * everything outside the login routes as protected, so it is covered by default.
 */
export default function McpPage() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={[{ label: "MCP Access" }]} />

        <main className="flex-1 p-6">
          <div className="max-w-4xl">
            <McpSettings />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
