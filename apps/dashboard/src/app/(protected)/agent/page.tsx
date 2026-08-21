"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";

import { AgentHarness } from "@/components/agent/agent-harness";
import { CopilotCard } from "@/components/agent/copilot-card";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  PageSkeleton,
  SettingsSkeleton,
} from "@/components/layout/page-skeleton";

/**
 * Settings for the agent that edits projects.
 *
 * Separate from Account because these are settings for a thing, not facts about
 * a person: what the agent runs on, and what it may reach.
 *
 * One page rather than tabs. Every box answers a part of the same question — what
 * will this agent do on my next turn — and splitting them across tabs meant the
 * switches lived on a different screen from the diagram that shows what they
 * change.
 */
export default function AgentSettingsPage() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <PageSkeleton breadcrumbs={[{ label: "Agent Settings" }]}>
        <SettingsSkeleton />
      </PageSkeleton>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={[{ label: "Agent Settings" }]} />

        <main className="flex-1 p-6">
          <div className="grid w-full grid-cols-1 gap-6">
            <CopilotCard />
            <AgentHarness />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
