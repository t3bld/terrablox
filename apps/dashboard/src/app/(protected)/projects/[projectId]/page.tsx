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
  Layers,
  Network,
  PanelLeftOpen,
  PanelRightOpen,
  Rocket,
  ScrollText,
  Wallet,
  Workflow,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  type TabDefinition,
  TabsNav,
  tabPanelProps,
} from "@/components/layout/tabs-nav";
import { ProjectActionsMenu } from "@/components/project-actions/project-actions-menu";
import { AwsProjectStrip } from "@/components/project-detail/aws-project-strip";
import { ChatPanel } from "@/components/project-detail/chat-panel";
import { CostPanel } from "@/components/project-detail/cost-panel";
import { DeployPanel } from "@/components/project-detail/deploy-panel";
import { DeploySetupWizard } from "@/components/project-detail/deploy-setup-wizard";
import { IntegrationGate } from "@/components/project-detail/integration-gate";
import { LocalInspector } from "@/components/project-detail/local-inspector";
import { LogPanel } from "@/components/project-detail/log-panel";
import { ModuleInspector } from "@/components/project-detail/module-inspector";
import { ModuleLibrary } from "@/components/project-detail/module-library";
import { ProjectArchitectureView } from "@/components/project-detail/project-architecture-view";
import { StatePanel } from "@/components/project-detail/state-panel";
import { useProjectAws } from "@/lib/aws/use-project-aws";
import { useIntegrationStatus } from "@/lib/integrations/use-integration-status";
import { canvasNodeId } from "@/lib/projects/locals";
import type {
  ProjectDto,
  ProjectGraph,
  ProjectGraphMutation,
  ProjectMutationResult,
} from "@/lib/projects/types";

type ProjectTab = "code" | "deploy" | "state" | "costs" | "log";

/**
 * The tab lives in the fragment, as `#deploy`, so a reload, a bookmark and the
 * back button all land where the user was.
 *
 * The fragment rather than a route segment: the tabs share one page's state — the
 * graph, the pending drops, the agent conversation — and splitting them into
 * routes would remount the canvas on every switch. It never reaches the server,
 * which is the honest place for "which of these panels am I looking at".
 *
 */
const URL_TABS: ProjectTab[] = ["code", "deploy", "state", "costs", "log"];
const DEFAULT_TAB: ProjectTab = "code";

function tabFromHash(hash: string): ProjectTab {
  const value = hash.replace(/^#/, "");
  return URL_TABS.find((tab) => tab === value) ?? DEFAULT_TAB;
}

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
  const router = useRouter();

  const [tab, setTabState] = useState<ProjectTab>(DEFAULT_TAB);

  /**
   * The fragment is a client-only fact, so it is read after mounting rather than
   * during render: the server has no way to know it, and rendering a different
   * tab than it did would be a hydration mismatch.
   *
   * `hashchange` covers someone editing the address bar, `popstate` covers the
   * back and forward buttons — `pushState` below fires neither, which is why the
   * click path sets the state itself.
   */
  useEffect(() => {
    const sync = () => setTabState(tabFromHash(window.location.hash));

    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);

    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  /**
   * Pushed rather than replaced, so the back button walks back through the tabs
   * the way it walks back through pages. The default tab drops the fragment
   * altogether instead of leaving a bare `#`.
   *
   * Written with the History API rather than the router: this changes nothing the
   * server renders, and a router navigation would put the whole page through a
   * transition to move a panel.
   */
  const setTab = useCallback((next: ProjectTab) => {
    setTabState(next);

    window.history.pushState(
      null,
      "",
      next === DEFAULT_TAB
        ? `${window.location.pathname}${window.location.search}`
        : `#${next}`,
    );
  }, []);
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Kept apart from `error`, which is for actions that failed and can be retried.
   * This one is a standing condition of the project: its repository cannot be
   * read, so the canvas is empty for a reason, and Delete needs to stop promising
   * the repository is safe.
   */
  const [repoError, setRepoError] = useState<string | null>(null);
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
  /** The module library, collapsed the same way the agent panel is. */
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [graphLevel, setGraphLevel] = useState<GraphLevel>("detail");
  const {
    status: integrations,
    loading: integrationsLoading,
    refresh: refreshIntegrations,
  } = useIntegrationStatus();

  // Read once for the whole page: the strip under the tabs shows it everywhere,
  // and the Deploy and State gates act on the same answer.
  const {
    state: aws,
    error: awsError,
    apply: applyAws,
    attach: attachAws,
  } = useProjectAws(projectId);

  /**
   * The account in use, or null for "not connected".
   *
   * An expired or unverified session counts as not connected: both need the same
   * sign-in, and both leave every AWS read failing until it happens.
   */
  const awsAccountId = aws?.connected ? aws.accountId : null;

  const infracostReady = integrations?.infracost.connected ?? false;

  // Deploy and State are never locked: connecting AWS now happens inside them,
  // so a lock would hide the only place the connection can be made. Costs still
  // locks, because an Infracost key is set up on the account page.
  const tabs = useMemo<TabDefinition<ProjectTab>[]>(
    () => [
      { value: "code", label: "Code", icon: Workflow },
      { value: "deploy", label: "Deploy", icon: Rocket },
      { value: "state", label: "State", icon: Layers },
      {
        value: "costs",
        label: "Costs",
        icon: Wallet,
        locked: !integrationsLoading && !infracostReady,
        lockedReason: INFRACOST_REASON,
      },
      // Last, because it is read after the fact. It replaces the History tab
      // that was hidden here: the same operations, under the decision that
      // produced them and the reason it was made.
      { value: "log", label: "Log", icon: ScrollText },
    ],
    [infracostReady, integrationsLoading],
  );

  /**
   * The project row and the repository it points at are two independent facts,
   * so they are settled independently.
   *
   * They used to share one `Promise.all`, which meant a repository deleted on
   * GitHub took the project's own page with it: the row loaded fine, but the
   * rejection threw the pair away, `project` stayed null, and the header's
   * actions menu — the only route to Delete — stayed disabled on a project that
   * now existed nowhere else. The one action still worth offering was the one
   * that had become unreachable.
   *
   * Kept apart, a missing repository is what it actually is: this page minus its
   * canvas.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const wantProject = fetch(`/api/projects/${projectId}`).then(
      async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load project");
        return body.project as ProjectDto;
      },
    );

    const wantGraph = fetch(`/api/projects/${projectId}/graph`).then(
      async (res) => {
        const body = await res.json();
        if (!res.ok)
          throw new Error(body?.error ?? "Failed to read repository");
        return body.graph as ProjectGraph;
      },
    );

    const settledProject = wantProject
      .then((loaded) => {
        if (!cancelled) setProject(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load project",
          );
        }
      });

    const settledGraph = wantGraph
      .then((loaded) => {
        if (!cancelled) {
          setGraph(loaded);
          setRepoError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRepoError(
            err instanceof Error ? err.message : "Failed to read repository",
          );
        }
      });

    Promise.all([settledProject, settledGraph]).finally(() => {
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
            <>
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

              <ProjectActionsMenu
                onDeleted={() => router.push("/projects")}
                projectId={projectId}
                projectName={project?.name ?? null}
                repoFullName={project?.repoFullName ?? null}
                // So the dialog stops assuring the user their Terraform is safe
                // on GitHub at the exact moment we know it is not readable.
                repoUnreachable={repoError !== null}
              />
            </>
          }
        />

        <TabsNav
          tabs={tabs}
          value={tab}
          onChange={setTab}
          idPrefix="project"
          label="Project views"
        />

        {/* Outside every tab panel: the account a project works against is true
            on the canvas as much as in Deploy, and a session that is about to run
            out is worth seeing before, not after, the next change. */}
        <AwsProjectStrip
          onChanged={applyAws}
          projectId={projectId}
          state={aws}
        />

        {/* Above the retryable errors, and in a warning tone rather than a
            destructive one: nothing failed just now, the repository is simply not
            there. The page below it still works — the Log is in the database, and
            the header can delete the project. */}
        {repoError ? (
          <p className="flex items-start gap-2 border-b bg-amber-500/10 px-4 py-2 text-amber-700 text-sm dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {repoError}
          </p>
        ) : null}

        {error ? (
          <p className="flex items-start gap-2 border-b bg-destructive/5 px-4 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}

        {tab === "deploy" ? (
          <div
            {...tabPanelProps("project", "deploy")}
            // A stable gutter keeps the centred column in the same place whether
            // the step is tall enough to scroll or not.
            className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
          >
            {/* No gate: connecting AWS is the wizard's first step, so the tab
                has to be able to render before there is a connection. */}
            <DeployPanel
              awsAccountId={awsAccountId}
              onAttachAws={attachAws}
              project={project}
              projectId={projectId}
            />
          </div>
        ) : tab === "state" ? (
          <div
            {...tabPanelProps("project", "state")}
            // Same stable gutter as Deploy: this tab shows the same wizard.
            className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
          >
            {/* The same wizard the Deploy tab shows. This tab reads the state
                bucket that setup creates, so until it exists there is nothing
                here to look at and only one thing to do. */}
            {awsError ? (
              <p className="flex items-center gap-2 p-6 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {awsError}
              </p>
            ) : aws === null ? (
              <Skeleton className="m-6 h-64" />
            ) : awsAccountId ? (
              <StatePanel projectId={projectId} />
            ) : (
              <DeploySetupWizard
                onAttachAws={attachAws}
                projectId={projectId}
              />
            )}
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
        ) : tab === "log" ? (
          // No scroll here: the panel splits into a list and a detail column that
          // scroll independently, which an outer scroller would collapse into one.
          <div
            {...tabPanelProps("project", "log")}
            className="flex min-h-0 flex-1"
          >
            <LogPanel projectId={projectId} />
          </div>
        ) : (
          <div
            {...tabPanelProps("project", "code")}
            className="flex min-h-0 flex-1"
          >
            {/* The library only. Values used to be listed underneath, which made
                this column a mixed inventory of "things to add" and "things that
                exist" — two different questions sharing one scroll. */}
            <aside
              className={`hidden shrink-0 border-r md:block ${
                libraryOpen ? "w-64" : "w-10"
              }`}
            >
              {/* Stays mounted while collapsed, so a search that narrowed the
                  list to the one module being wired up survives folding the
                  column away to look at the canvas. */}
              <div className={libraryOpen ? "h-full" : "hidden"}>
                <ModuleLibrary
                  disabled={busy || loading}
                  suggestions={suggestions}
                  onAdd={(moduleId, name) =>
                    void mutate(
                      { action: "add-module", moduleId },
                      { optimisticLabel: name },
                    )
                  }
                  onCollapse={() => setLibraryOpen(false)}
                />
              </div>

              <button
                type="button"
                onClick={() => setLibraryOpen(true)}
                className={`h-full w-full flex-col items-center gap-2 py-3 text-muted-foreground hover:bg-muted hover:text-foreground ${
                  libraryOpen ? "hidden" : "flex"
                }`}
                aria-label="Expand module library"
              >
                <PanelLeftOpen className="h-4 w-4 shrink-0" />
                <span className="truncate text-xs [writing-mode:vertical-rl]">
                  Modules
                </span>
              </button>
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
