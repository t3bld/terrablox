"use client";

import {
  ProjectCanvas,
  type ProjectCanvasConnection,
  type ProjectCanvasEdge,
  type ProjectCanvasNode,
} from "@terrablox/graph";
import { Dialog, DialogContent, DialogTitle } from "@terrablox/ui/dialog";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  ExternalLink,
  GitCommit,
  History,
  Layers,
  Network,
  PanelRightOpen,
  Rocket,
  Wallet,
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
import { AwsProjectGate } from "@/components/project-detail/aws-project-gate";
import { ChatPanel } from "@/components/project-detail/chat-panel";
import { CostPanel } from "@/components/project-detail/cost-panel";
import { DeployPanel } from "@/components/project-detail/deploy-panel";
import { HistoryPanel } from "@/components/project-detail/history-panel";
import { IntegrationGate } from "@/components/project-detail/integration-gate";
import { LocalInspector } from "@/components/project-detail/local-inspector";
import { ModuleInspector } from "@/components/project-detail/module-inspector";
import { ModuleLibrary } from "@/components/project-detail/module-library";
import { ProjectArchitectureView } from "@/components/project-detail/project-architecture-view";
import { StatePanel } from "@/components/project-detail/state-panel";
import { useIntegrationStatus } from "@/lib/integrations/use-integration-status";
import { canvasNodeId } from "@/lib/projects/locals";
import type {
  ProjectDto,
  ProjectGraph,
  ProjectGraphMutation,
  ProjectMutationResult,
} from "@/lib/projects/types";

type ProjectTab = "code" | "deploy" | "state" | "costs" | "history";

/**
 * How much of the same graph is drawn: the modules a project wires together,
 * or the AWS services those modules deploy. One canvas, two zoom levels — a
 * second tab would suggest two different things to keep in sync.
 */
type GraphLevel = "detail" | "architecture";

const GRAPH_LEVELS: {
  value: GraphLevel;
  label: string;
  icon: typeof Workflow;
  hint: string;
}[] = [
  {
    value: "detail",
    label: "Detail",
    icon: Workflow,
    hint: "Module blocks, their inputs and the wires between them",
  },
  {
    value: "architecture",
    label: "Architecture",
    icon: Network,
    hint: "The AWS services these modules deploy, and how they connect",
  },
];

const INFRACOST_REASON =
  "Connect Infracost in Account settings to use this tab";

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
  /**
   * Modules dropped on the canvas whose commit has not come back yet.
   *
   * Separate from `graph` on purpose — see `mutate`. A list rather than a single
   * entry because nothing stops a user from dropping a second module while the
   * first one is still being written.
   */
  const [pending, setPending] = useState<
    Array<{
      id: string;
      label: string;
      position: { x: number; y: number } | null;
    }>
  >([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [graphLevel, setGraphLevel] = useState<GraphLevel>("detail");
  const {
    status: integrations,
    loading: integrationsLoading,
    refresh: refreshIntegrations,
  } = useIntegrationStatus();

  const infracostReady = integrations?.infracost.connected ?? false;

  // Deploy and State are never locked: connecting AWS now happens inside them,
  // so a lock would hide the only place the connection can be made. Costs still
  // locks, because an Infracost key is set up on the account page.
  const tabs = useMemo<TabDefinition<ProjectTab>[]>(
    () => [
      { value: "code", label: "Code", icon: Workflow },
      { value: "history", label: "History", icon: History },
      { value: "deploy", label: "Deploy", icon: Rocket },
      { value: "state", label: "State", icon: Layers },
      {
        value: "costs",
        label: "Costs",
        icon: Wallet,
        locked: !integrationsLoading && !infracostReady,
        lockedReason: INFRACOST_REASON,
      },
    ],
    [infracostReady, integrationsLoading],
  );

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
   * Every graph edit goes through here. The canvas is redrawn from what the
   * server committed, so a failed commit cannot leave a change on screen that
   * is not in the repository.
   *
   * `optimisticLabel` is the one exception, and only for adding a module: the
   * commit is a round trip to the GitHub API, and until it returned the canvas
   * showed nothing at all — a drop looked like it had been ignored. A greyed
   * placeholder appears at once and is replaced by the committed graph, or
   * removed again if the commit fails. It is a placeholder rather than a real
   * node because the block's name and ports are the server's to decide.
   */
  const mutate = useCallback(
    async (
      mutation: ProjectGraphMutation,
      options?: { optimisticLabel?: string },
    ) => {
      setBusy(true);
      setError(null);

      const placeholderId =
        mutation.action === "add-module" && options?.optimisticLabel
          ? `pending:${Date.now()}`
          : null;

      if (placeholderId && mutation.action === "add-module") {
        // Kept out of `graph`, which stays exactly what the server committed.
        // A fake node in there would reach the inspector, the gap list and the
        // input pickers, all of which would be describing a block that does not
        // exist yet.
        setPending((current) => [
          ...current,
          {
            id: placeholderId,
            label: options?.optimisticLabel ?? "Module",
            position: mutation.position ?? null,
          },
        ]);
      }

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

        // A node that just appeared is the one the user is about to
        // configure, so the inspector follows it. This covers renames too,
        // where the old label no longer exists.
        const before = new Set(
          (graph?.nodes ?? []).map((node) => canvasNodeId(node)),
        );
        const appeared = result.graph.nodes.filter(
          (node) => !before.has(canvasNodeId(node)),
        );

        if (appeared.length === 1 && appeared[0]) {
          setSelectedNodeId(canvasNodeId(appeared[0]));
        } else {
          setSelectedNodeId((current) =>
            current &&
            result.graph.nodes.some((node) => canvasNodeId(node) === current)
              ? current
              : null,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Change failed");
      } finally {
        setBusy(false);
        // Dropped on both paths: on success the committed graph now contains the
        // real node, and on failure nothing was committed, so leaving the
        // placeholder would claim a module that is not in the repository.
        if (placeholderId) {
          setPending((current) =>
            current.filter((entry) => entry.id !== placeholderId),
          );
        }
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

  /**
   * Modules only.
   *
   * Values are deliberately absent: they are drawn nowhere and reached from the
   * input that reads them. A value as a node cost a box and two handles to say
   * something the input row says better, and it made a six-module project read as
   * a twenty-node system. The graph still knows about them — every input picker
   * is built from the same nodes.
   */
  const canvasNodes = useMemo<ProjectCanvasNode[]>(
    () => [
      ...(graph?.nodes ?? [])
        .filter((node) => node.kind === "module")
        .map((node) => ({
          id: node.id,
          name: node.id,
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
      // Modules whose commit is still running, drawn where they were dropped.
      ...pending.map((entry) => ({
        id: entry.id,
        name: entry.id,
        label: entry.label,
        inputs: [],
        outputs: [],
        position: entry.position,
        pending: true,
      })),
    ],
    [graph, pending],
  );

  // Module-to-module wiring only. An edge with a value at either end would now
  // point at a node that is not on the canvas.
  const canvasEdges = useMemo<ProjectCanvasEdge[]>(
    () =>
      (graph?.edges ?? [])
        .filter(
          (edge) =>
            edge.sourceKind === "module" && edge.targetKind === "module",
        )
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          links: edge.links,
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
    () =>
      graph?.nodes.find((node) => canvasNodeId(node) === selectedNodeId) ??
      null,
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
          actions={
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {busy ? "Committing…" : null}
              {lastCommit && !busy ? (
                <>
                  <GitCommit className="h-3 w-3" />
                  {lastCommit}
                </>
              ) : null}
              {project ? (
                <a
                  href={
                    project.repoUrl ??
                    `https://github.com/${project.repoFullName}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="flex max-w-[min(42vw,28rem)] items-center gap-1 truncate hover:text-foreground"
                >
                  <span className="truncate">
                    {project.repoFullName}@{project.repoBranch}
                  </span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              ) : null}
            </div>
          }
        />

        <TabsNav
          tabs={tabs}
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
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <AwsProjectGate
              blocked={[
                "Generating the GitHub Actions pipeline for this project",
                "Starting a plan or an apply from here",
                "Reading which role and state bucket the pipeline should use",
              ]}
              explanation="Deployments run in your own AWS account. TerraBlox never holds AWS keys, so this project needs an account of its own to know where to deploy."
              projectId={projectId}
            >
              <DeployPanel projectId={projectId} project={project} />
            </AwsProjectGate>
          </div>
        ) : tab === "state" ? (
          <div
            {...tabPanelProps("project", "state")}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <AwsProjectGate
              blocked={[
                "The inventory of what is really running",
                "Links into the AWS console for each resource",
                "Refreshing the snapshot after an apply",
              ]}
              explanation="This tab shows what exists in this project's AWS account, which only means something once one is connected."
              projectId={projectId}
            >
              <StatePanel projectId={projectId} />
            </AwsProjectGate>
          </div>
        ) : tab === "costs" ? (
          <div
            {...tabPanelProps("project", "costs")}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {integrationsLoading ? (
              <Skeleton className="m-6 h-64" />
            ) : infracostReady ? (
              <CostPanel projectId={projectId} />
            ) : (
              <IntegrationGate
                blocked={[
                  "The monthly estimate for what this project would run",
                  "Per-module and per-resource pricing",
                  "Re-pricing the plan after a change",
                ]}
                explanation="Estimates are priced through Infracost with your own API key. TerraBlox keeps no shared key, so nothing can be priced until you add one."
                onRecheck={() => void refreshIntegrations()}
                provider="Infracost"
              />
            )}
          </div>
        ) : tab === "history" ? (
          <div
            {...tabPanelProps("project", "history")}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <HistoryPanel projectId={projectId} />
          </div>
        ) : (
          <div
            {...tabPanelProps("project", "code")}
            className="flex min-h-0 flex-1"
          >
            {/* The library only. Values used to be listed underneath, which made
                this column a mixed inventory of "things to add" and "things that
                exist" — two different questions sharing one scroll. */}
            <aside className="hidden w-64 shrink-0 overflow-y-auto border-r md:block">
              <ModuleLibrary
                disabled={busy || loading}
                suggestions={suggestions}
                onAdd={(moduleId, name) =>
                  void mutate(
                    { action: "add-module", moduleId },
                    { optimisticLabel: name },
                  )
                }
              />
            </aside>

            <main className="relative min-w-0 flex-1 p-3">
              {/* Sits on the canvas rather than above it: the level belongs to
                  the drawing, and the drawing already owns the whole area. */}
              <div className="absolute top-5 left-5 z-10 flex items-center rounded-lg border bg-background/95 p-0.5 shadow-sm backdrop-blur">
                {GRAPH_LEVELS.map((level) => (
                  <button
                    key={level.value}
                    type="button"
                    aria-pressed={graphLevel === level.value}
                    onClick={() => setGraphLevel(level.value)}
                    title={level.hint}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition-colors ${
                      graphLevel === level.value
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <level.icon className="h-3.5 w-3.5 shrink-0" />
                    {level.label}
                  </button>
                ))}
              </div>

              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : graphLevel === "architecture" ? (
                <ProjectArchitectureView
                  projectId={projectId}
                  graph={graph}
                  onSelectModule={(name) => setSelectedNodeId(name)}
                />
              ) : (
                <ProjectCanvas
                  nodes={canvasNodes}
                  edges={canvasEdges}
                  busy={busy}
                  selectedNodeId={selectedNodeId}
                  onNodeClick={(node) => setSelectedNodeId(node.id)}
                  onConnect={handleConnect}
                  onDisconnect={(link) =>
                    void mutate({ action: "disconnect", ...link })
                  }
                  onRemoveNode={({ name }) =>
                    void mutate({ action: "remove-module", name })
                  }
                  onDropModule={(moduleId, position, name) =>
                    void mutate(
                      { action: "add-module", moduleId, position },
                      { optimisticLabel: name ?? "Module" },
                    )
                  }
                  onPositionsChange={savePositions}
                />
              )}
            </main>

            {/* The agent keeps the whole column. A module used to take the top
                half of it, which left both cramped: the conversation lost half
                its height exactly when a module was open to ask about, and the
                module got a 384px column to lay out a dozen inputs in. */}
            <aside
              className={`hidden shrink-0 border-l lg:block ${
                panelOpen ? "w-96" : "w-10"
              }`}
            >
              {/* Stays mounted while collapsed: a half-written message to the
                  agent must survive a detour to a module. */}
              <div className={panelOpen ? "h-full" : "hidden"}>
                <ChatPanel
                  projectId={projectId}
                  onGraphChanged={setGraph}
                  onCollapse={() => setPanelOpen(false)}
                />
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
                  Agent
                </span>
              </button>
            </aside>
          </div>
        )}

        {/* Details as a dialog rather than a docked panel: a module's inputs are
            a form, and a form wants width. Selection is still the graph's, so
            closing the dialog is the same thing as deselecting. */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) setSelectedNodeId(null);
          }}
          open={selectedNode !== null}
        >
          <DialogContent className="max-h-[90vh] w-[95vw] max-w-4xl overflow-hidden p-0">
            {/* The panel below shows the name as a heading it can also rename, so
                this exists only to give the dialog its accessible name. */}
            <DialogTitle className="sr-only">
              {selectedNode
                ? selectedNode.kind === "local"
                  ? `Value ${selectedNode.id}`
                  : `Module ${selectedNode.label}`
                : "Details"}
            </DialogTitle>

            {/* A fixed height rather than `h-full`: both panels are built as a
                header plus a scrolling body, and that needs something to scroll
                inside. */}
            {selectedNode && graph ? (
              <div className="h-[80vh]">
                {selectedNode.kind === "local" ? (
                  <LocalInspector
                    busy={busy}
                    graph={graph}
                    node={selectedNode}
                    onRemove={() => {
                      void mutate({
                        action: "remove-local",
                        name: selectedNode.id,
                      });
                      setSelectedNodeId(null);
                    }}
                    onRename={(newName) =>
                      void mutate({
                        action: "rename-local",
                        name: selectedNode.id,
                        newName,
                      })
                    }
                    onSetValue={(value) =>
                      void mutate({
                        action: "set-local",
                        name: selectedNode.id,
                        value,
                      })
                    }
                  />
                ) : (
                  <ModuleInspector
                    busy={busy}
                    graph={graph}
                    node={selectedNode}
                    onMutate={(mutation) => void mutate(mutation)}
                  />
                )}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </SidebarInset>
    </SidebarProvider>
  );
}
