"use client";

import type {
  DependencyGraphEdge,
  DependencyGraphNode,
} from "@terrablox/graph/dependency-graph";
import { DependencyGraph } from "@terrablox/graph/dependency-graph";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Skeleton } from "@terrablox/ui/skeleton";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface AgentContextView {
  model: string;
  reasoningEffort: string | null;
  githubConnected: boolean;
  instructionsLength: number;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
  }>;
  mcpServers: Array<{
    id: string;
    name: string;
    url: string;
    enabled: boolean;
  }>;
  moduleCount: number;
  projectCount: number;
  tools: Array<{
    name: string;
    label: string;
    summary: string;
    enabled: boolean;
  }>;
}

/**
 * What the project agent knows and what it can reach.
 *
 * The graph deliberately shows only what is active, so it always answers "what
 * does the agent have?" without qualification. The switches below it are where
 * inactive things live, and flipping one makes a node appear or disappear.
 */
export function AgentContextGraph() {
  const [context, setContext] = useState<AgentContextView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const graph = useMemo(
    () => (context ? buildGraph(context) : null),
    [context],
  );

  const load = useCallback(async () => {
    const response = await fetch("/api/agent/context");
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? "Failed to load");
    return body as AgentContextView;
  }, []);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((next) => {
        if (!cancelled) setContext(next);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the agent's context.");
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  /** Re-reads the context after a change so the graph shows the saved truth. */
  async function commit(id: string, request: () => Promise<Response>) {
    setBusy(id);
    setError(null);

    try {
      const response = await request();
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The change was not saved.");
      }
      setContext(await load());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The change was not saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  function toggleSkill(id: string, enabled: boolean) {
    if (!context) return;

    const skills = context.skills
      .filter((skill) => (skill.id === id ? !enabled : skill.enabled))
      .map((skill) => skill.id);

    return commit(id, () =>
      fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills }),
      }),
    );
  }

  function toggleServer(id: string, enabled: boolean) {
    return commit(id, () =>
      fetch(`/api/agent/mcp/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      }),
    );
  }

  function toggleTool(name: string, enabled: boolean) {
    if (!context) return;

    const disabledTools = context.tools
      .filter((tool) => (tool.name === name ? enabled : !tool.enabled))
      .map((tool) => tool.name);

    return commit(name, () =>
      fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabledTools }),
      }),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent context</CardTitle>
        <CardDescription>
          Everything the project agent draws on for a turn, and everything it
          can reach beyond this app. Switch something off and it leaves the
          graph.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}

        {!context || !graph ? (
          <Skeleton className="h-[28rem] w-full" />
        ) : (
          <>
            <DependencyGraph
              className="h-[28rem] w-full"
              direction="LR"
              edges={graph.edges}
              nodes={graph.nodes}
              showMiniMap={false}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Knowledge</h3>
                <div className="grid gap-2">
                  {context.skills.map((skill) => (
                    <ToggleRow
                      description={skill.description}
                      disabled={busy === skill.id}
                      key={skill.id}
                      label={skill.name}
                      on={skill.enabled}
                      onToggle={() => void toggleSkill(skill.id, skill.enabled)}
                    />
                  ))}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Integrations</h3>
                {context.mcpServers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No MCP servers yet. Copilot and GitHub are always on.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {context.mcpServers.map((server) => (
                      <ToggleRow
                        description={hostOf(server.url)}
                        disabled={busy === server.id}
                        key={server.id}
                        label={server.name}
                        on={server.enabled}
                        onToggle={() =>
                          void toggleServer(server.id, server.enabled)
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">What it may change</h3>
              <p className="text-xs text-muted-foreground">
                Switched off means the agent never receives the tool, so it says
                so instead of trying and failing.
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {context.tools.map((tool) => (
                  <ToggleRow
                    description={tool.summary}
                    disabled={busy === tool.name}
                    key={tool.name}
                    label={tool.label}
                    on={tool.enabled}
                    onToggle={() => void toggleTool(tool.name, tool.enabled)}
                  />
                ))}
              </div>
            </section>

            <p className="text-xs text-muted-foreground">
              The open project, your module library, GitHub and Copilot cannot
              be switched off — without them there is no turn to run.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The active context, as a hub with one branch for knowledge and one for reach. */
function buildGraph(context: AgentContextView): {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
} {
  const nodes: DependencyGraphNode[] = [
    {
      id: "agent",
      label: "Project agent",
      kind: "module",
      group: "Agent",
      description: `Edits a project through ${context.tools.length} tools; it cannot write free-form Terraform.`,
      metadata: { tools: context.tools.join(", ") },
    },
    {
      id: "knowledge",
      label: "Knowledge",
      kind: "module",
      group: "Context",
      description: "Put into the prompt at the start of every turn.",
    },
    {
      id: "integrations",
      label: "Integrations",
      kind: "module",
      group: "Context",
      description: "Systems the agent talks to while it works.",
    },
  ];

  const edges: DependencyGraphEdge[] = [
    { source: "agent", target: "knowledge" },
    { source: "agent", target: "integrations" },
  ];

  const addKnowledge = (node: DependencyGraphNode) => {
    nodes.push({ ...node, kind: "resource", group: "Knowledge" });
    edges.push({ source: "knowledge", target: node.id });
  };

  const addIntegration = (node: DependencyGraphNode) => {
    nodes.push({ ...node, kind: "external-module", group: "Integration" });
    edges.push({ source: "integrations", target: node.id });
  };

  addKnowledge({
    id: "project-graph",
    label: "Open project",
    description:
      "Module blocks, wiring, unset required inputs and the files they live in.",
  });

  addKnowledge({
    id: "library",
    label: "Module library",
    description: "Your imported Terraform modules, the only ones it may add.",
    metadata: { modules: context.moduleCount },
  });

  if (context.instructionsLength > 0) {
    addKnowledge({
      id: "instructions",
      label: "Your instructions",
      description: "Your own house rules, applied unless they conflict.",
      metadata: { characters: context.instructionsLength },
    });
  }

  for (const skill of context.skills.filter((entry) => entry.enabled)) {
    addKnowledge({
      id: `skill:${skill.id}`,
      label: skill.name,
      description: skill.description,
      metadata: { type: "skill" },
    });
  }

  addIntegration({
    id: "copilot",
    label: "GitHub Copilot",
    description: "Runs the turn on your own Copilot seat.",
    metadata: {
      model: context.model,
      effort: context.reasoningEffort ?? "model default",
    },
  });

  addIntegration({
    id: "github",
    label: "GitHub repositories",
    description: context.githubConnected
      ? "Reads the project's Terraform and commits every change it makes."
      : "Not connected, so the agent cannot run.",
    metadata: {
      projects: context.projectCount,
      status: context.githubConnected ? "connected" : "not connected",
    },
  });

  for (const server of context.mcpServers.filter((entry) => entry.enabled)) {
    addIntegration({
      id: `mcp:${server.id}`,
      label: server.name,
      description: `Its tools are offered to the agent under "${server.name}".`,
      metadata: { host: hostOf(server.url) },
    });
  }

  return { nodes, edges };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
