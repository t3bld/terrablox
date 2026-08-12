"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";

import { AgentInstructionsCard } from "@/components/agent/agent-instructions-card";
import { AgentMcpCard } from "@/components/agent/agent-mcp-card";
import { CopilotCard } from "@/components/agent/copilot-card";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";

/**
 * Settings for the agent that edits projects.
 *
 * Separate from Account because these are settings for a thing, not facts
 * about a person: what the agent runs on, and later what it may reach.
 */
export default function AgentSettingsPage() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          breadcrumbs={[{ label: "Agent" }]}
          meta="How the project agent runs, and what it is allowed to reach."
        />

        <main className="flex-1 p-6">
          <div className="grid max-w-3xl grid-cols-1 gap-6">
            <CopilotCard />
            <AgentInstructionsCard />
            <AgentMcpCard />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
