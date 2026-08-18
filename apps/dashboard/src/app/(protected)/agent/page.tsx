"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Network, Settings2 } from "lucide-react";
import { useState } from "react";

import { AgentContextGraph } from "@/components/agent/agent-context-graph";
import { AgentInstructionsCard } from "@/components/agent/agent-instructions-card";
import { CopilotCard } from "@/components/agent/copilot-card";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  PageSkeleton,
  SettingsSkeleton,
} from "@/components/layout/page-skeleton";
import { TabsNav, tabPanelProps } from "@/components/layout/tabs-nav";

type AgentTab = "settings" | "context";

const TABS = [
  { value: "settings" as const, label: "Settings", icon: Settings2 },
  { value: "context" as const, label: "Context", icon: Network },
];

/**
 * Settings for the agent that edits projects.
 *
 * Separate from Account because these are settings for a thing, not facts
 * about a person: what the agent runs on, and later what it may reach.
 */
export default function AgentSettingsPage() {
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<AgentTab>("settings");

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

        <TabsNav
          idPrefix="agent"
          label="Agent settings"
          onChange={setTab}
          tabs={TABS}
          value={tab}
        />

        <main className="flex-1 p-6">
          {tab === "settings" ? (
            <div
              className="grid w-full grid-cols-1 gap-6"
              {...tabPanelProps("agent", "settings")}
            >
              <CopilotCard />
              <AgentInstructionsCard />
            </div>
          ) : (
            <div className="w-full" {...tabPanelProps("agent", "context")}>
              <AgentContextGraph />
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
