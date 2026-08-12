"use client";

import {
  ProjectCanvas,
  type ProjectCanvasConnection,
  type ProjectCanvasNode,
} from "@terrablox/graph";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  ExternalLink,
  GitCommit,
  Layers,
  PanelRightOpen,
  Rocket,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  type TabDefinition,
  TabsNav,
  tabPanelProps,
} from "@/components/layout/tabs-nav";
import { ChatPanel } from "@/components/project-detail/chat-panel";
import { DeployPanel } from "@/components/project-detail/deploy-panel";
import { ModuleInspector } from "@/components/project-detail/module-inspector";
import { ModuleLibrary } from "@/components/project-detail/module-library";
import { StatePanel } from "@/components/project-detail/state-panel";
import type {
  ProjectDto,
  ProjectGraph,
  ProjectGraphMutation,
  ProjectMutationResult,
} from "@/lib/projects/types";

type ProjectTab = "code" | "deploy" | "state";

const TABS: TabDefinition<ProjectTab>[] = [
  { value: "code", label: "Code", icon: Workflow },
  { value: "deploy", label: "Deploy", icon: Rocket },
  { value: "state", label: "State", icon: Layers },
];

export default function ProjectDetailPage({
  params,
}: {
  params: { projectId: string };
}) {
  const { projectId } = params;

  const [tab, setTab] = useState<ProjectTab>("code");
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetch(`/api/projects/${projectId}`).then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load project");
        return body.project as ProjectDto;
      }),
      fetch(`/api/projects/${projectId}/graph`).then(async (res) => {
        const body = await res.json();
        if (!res.ok)
          throw new Error(body?.error ?? "Failed to read repository");
        return body.graph as ProjectGraph;
      }),
    ])
      .then(([loadedProject, loadedGraph]) => {
        if (cancelled) return;
        setProject(loadedProject);
        setGraph(loadedGraph);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load project",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Every graph edit goes through here, so the canvas always shows the state
   * the repository is actually in rather than an optimistic guess that a failed
   * commit would leave behind.
   */
  const mutate = useCallback(
    async (mutation: ProjectGraphMutation) => {
      setBusy(true);
      setError(null);

      try {
        const response = await fetch(`/api/projects/${projectId}/graph`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mutation),
        });

        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "Change failed");

        const result = body as ProjectMutationResult;
        setGraph(result.graph);
        setLastCommit(result.commit?.sha.slice(0, 7) ?? null);

        // A module that just appeared is the one the user is about to
        // configure, so the inspector follows it. This covers renames too,
        // where the old label no longer exists.
        const before = new Set(graph?.nodes.map((node) => node.id) ?? []);
        const appeared = result.graph.nodes.filter(
          (node) => !before.has(node.id),
        );

        if (appeared.length === 1) {
          setSelectedNodeId(appeared[0]?.id ?? null);
        } else {
          setSelectedNodeId((current) =>
            current && result.graph.nodes.some((node) => node.id === current)
              ? current
              : null,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Change failed");
      } finally {
        setBusy(false);
      }
    },
    [projectId, graph],
  );

  const savePositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      // Layout is cosmetic, so a failed save is not worth interrupting the user
      // for; the positions are recomputed on the next load either way.
      void fetch(`/api/projects/${projectId}/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
      }).catch(() => {});
    },
    [projectId],
  );

  const canvasNodes = useMemo<ProjectCanvasNode[]>(
    () =>
      (graph?.nodes ?? []).map((node) => ({
        id: node.id,
        label: node.label,
        moduleName: node.moduleName,
        version: node.version,
        source: node.source,
        linked: node.moduleId !== null,
        inputs: node.inputs,
        outputs: node.outputs,
        setArguments: node.setArguments,
        position: node.position,
      })),
    [graph],
  );

  const handleConnect = useCallback(
    (connection: ProjectCanvasConnection) => {
      void mutate({ action: "connect", ...connection });
    },
    [mutate],
  );

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph, selectedNodeId],
  );

  /**
   * Library modules that would satisfy something the canvas is missing, keyed
   * by module id so the palette can pin them without knowing about the graph.
   */
  const suggestions = useMemo(() => {
    const reasons: Record<string, string> = {};

    for (const gap of graph?.gaps ?? []) {
      // A gap that an existing module can already cover is not a reason to add
      // another one — the user just has to draw the wire.
      if (gap.wirable.length > 0) continue;

      for (const candidate of gap.candidates) {
        reasons[candidate.moduleId] ??= `${gap.node} needs ${gap.input}`;
      }
    }

    return reasons;
  }, [graph]);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        <PageHeader
          loading={loading}
          breadcrumbs={[
            { label: "Projects", href: "/projects" },
            { label: project?.name ?? "Project" },
          ]}
          meta={
            project ? (
              <a
                href={
                  project.repoUrl ??
                  `https://github.com/${project.repoFullName}`
                }
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 hover:text-foreground"
              >
                {project.repoFullName}
                <span className="opacity-60">@{project.repoBranch}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null
          }
          actions={
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {busy ? "Committing…" : null}
              {lastCommit && !busy ? (
                <>
                  <GitCommit className="h-3 w-3" />
                  {lastCommit}
                </>
              ) : null}
            </span>
          }
        />

        <TabsNav
          tabs={TABS}
          value={tab}
          onChange={setTab}
          idPrefix="project"
          label="Project views"
        />

        {error ? (
          <p className="flex items-start gap-2 border-b bg-destructive/5 px-4 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}

        {tab === "deploy" ? (
          <div
            {...tabPanelProps("project", "deploy")}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <DeployPanel projectId={projectId} project={project} />
          </div>
        ) : tab === "state" ? (
          <div
            {...tabPanelProps("project", "state")}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <StatePanel projectId={projectId} />
          </div>
        ) : (
          <div
            {...tabPanelProps("project", "code")}
            className="flex min-h-0 flex-1"
          >
            <aside className="hidden w-56 shrink-0 border-r md:block">
              <ModuleLibrary
                disabled={busy || loading}
                suggestions={suggestions}
                onAdd={(moduleId) =>
                  void mutate({ action: "add-module", moduleId })
                }
              />
            </aside>

            <main className="min-w-0 flex-1 p-3">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ProjectCanvas
                  nodes={canvasNodes}
                  edges={graph?.edges ?? []}
                  busy={busy}
                  selectedNodeId={selectedNodeId}
                  onNodeClick={(node) => {
                    setSelectedNodeId(node.id);
                    setPanelOpen(true);
                  }}
                  onConnect={handleConnect}
                  onDisconnect={(link) =>
                    void mutate({ action: "disconnect", ...link })
                  }
                  onRemoveNode={(name) =>
                    void mutate({ action: "remove-module", name })
                  }
                  onDropModule={(moduleId, position) =>
                    void mutate({ action: "add-module", moduleId, position })
                  }
                  onPositionsChange={savePositions}
                />
              )}
            </main>

            <aside
              className={`hidden shrink-0 border-l lg:block ${
                panelOpen ? "w-96" : "w-10"
              }`}
            >
              {/* Everything stays mounted while collapsed: a half-written
                  message to the agent must survive a detour to a module. */}
              <div className={panelOpen ? "h-full" : "hidden"}>
                <div className={selectedNode ? "h-full" : "hidden"}>
                  {selectedNode && graph ? (
                    <ModuleInspector
                      node={selectedNode}
                      graph={graph}
                      busy={busy}
                      onMutate={(mutation) => void mutate(mutation)}
                      onClose={() => setSelectedNodeId(null)}
                      onCollapse={() => setPanelOpen(false)}
                    />
                  ) : null}
                </div>
                <div className={selectedNode ? "hidden" : "h-full"}>
                  <ChatPanel
                    projectId={projectId}
                    onGraphChanged={setGraph}
                    onCollapse={() => setPanelOpen(false)}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                className={`h-full w-full flex-col items-center gap-2 py-3 text-muted-foreground hover:bg-muted hover:text-foreground ${
                  panelOpen ? "hidden" : "flex"
                }`}
                aria-label="Expand agent panel"
              >
                <PanelRightOpen className="h-4 w-4 shrink-0" />
                <span className="truncate text-xs [writing-mode:vertical-rl]">
                  {selectedNode ? selectedNode.label : "Agent"}
                </span>
              </button>
            </aside>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
