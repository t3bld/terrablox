"use client";

import {
  ArchitectureDiagram,
  type ArchitectureDiagramNode,
} from "@terrablox/graph";
import { Skeleton } from "@terrablox/ui/skeleton";
import { LayoutGrid } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectGraph } from "@/lib/projects/types";
import type {
  ArchitectureModuleCall,
  ArchitectureReference,
  NestedModuleData,
} from "@/lib/terraform/architecture-graph";
import { buildArchitecture } from "@/lib/terraform/architecture-graph";
import { layoutArchitecture } from "@/lib/terraform/architecture-layout";

/**
 * The project canvas one level up.
 *
 * The editable canvas answers "which modules does this project call and how are
 * they wired"; this view answers "what does that actually deploy". Both read
 * the same graph — the trick is that a project *is* a module with nothing but
 * `module` blocks in it, so the same builder that draws a wrapper module's
 * architecture draws the project's when handed its blocks as calls.
 */

interface NestedModule {
  id: string;
  name: string;
  versionTag: string | null;
  resources: NestedModuleData["resources"];
  references: NestedModuleData["references"];
  moduleCalls: {
    name: string;
    source: string | null;
    linkedModule: { moduleId: string; exactVersion: boolean } | null;
  }[];
}

/**
 * Beyond this many boxes a diagram stops being readable, so deeper levels stay
 * folded until the reader opens them. The project's own blocks are always
 * opened — showing them closed would just be the canvas again.
 */
const AUTO_EXPAND_BUDGET = 40;

interface ProjectArchitectureViewProps {
  projectId: string;
  graph: ProjectGraph | null;
  className?: string;
  /** Selecting a module frame drives the same inspector as the canvas does. */
  onSelectModule?: (blockLabel: string) => void;
}

export function ProjectArchitectureView({
  projectId,
  graph,
  className,
  onSelectModule,
}: ProjectArchitectureViewProps) {
  const [modules, setModules] = useState<Record<string, NestedModule> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Auto-expansion runs until nothing more fits, then hands control over: a
  // module the reader closed must not spring open again on the next render.
  const autoExpandSettled = useRef(false);

  const moduleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of graph?.nodes ?? [])
      if (node.moduleId) ids.add(node.moduleId);
    return [...ids].sort();
  }, [graph]);

  const moduleKey = moduleIds.join(",");

  useEffect(() => {
    if (!moduleKey) {
      setModules({});
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    autoExpandSettled.current = false;

    void (async () => {
      try {
        const response = await fetch(
          `/api/projects/${projectId}/architecture?modules=${encodeURIComponent(moduleKey)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = response.ok
          ? ((await response.json()) as {
              modules: Record<string, NestedModule>;
            })
          : null;
        if (!controller.signal.aborted) setModules(body?.modules ?? {});
      } catch {
        // A failed load costs the architecture level, not the page: the canvas
        // is one click away and holds everything this view was derived from.
        if (!controller.signal.aborted) setModules({});
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [projectId, moduleKey]);

  const moduleFor = useCallback(
    (call: ArchitectureModuleCall): NestedModuleData | null => {
      const target = call.moduleId ? modules?.[call.moduleId] : null;
      if (!target) return null;

      return {
        id: target.id,
        name: target.name,
        versionTag: target.versionTag,
        resources: target.resources,
        references: target.references,
        moduleCalls: target.moduleCalls
          .filter((c) => c.source)
          .map((c) => ({
            name: c.name,
            source: c.source as string,
            moduleId: c.linkedModule?.moduleId,
          })),
      };
    },
    [modules],
  );

  // The project's `module` blocks, presented to the builder as the calls of an
  // imaginary root module — which is exactly what the root Terraform file is.
  const moduleCalls = useMemo<ArchitectureModuleCall[]>(
    () =>
      (graph?.nodes ?? []).map((node) => ({
        name: node.id,
        source: node.source ?? "",
        moduleId: node.moduleId,
      })),
    [graph],
  );

  // A wire on the canvas is a reference in Terraform: the consuming block names
  // the producing one, so the arrow runs from target back to source.
  const references = useMemo<ArchitectureReference[]>(
    () =>
      (graph?.edges ?? []).map((edge) => ({
        fromAddress: `module.${edge.target}`,
        toAddress: `module.${edge.source}`,
        attributes: edge.links.map((link) => link.targetInput),
      })),
    [graph],
  );

  const architecture = useMemo(
    () =>
      buildArchitecture([], references, moduleCalls, {
        expanded: expanded as Set<string>,
        moduleFor,
      }),
    [references, moduleCalls, expanded, moduleFor],
  );

  useEffect(() => {
    if (loading || autoExpandSettled.current) return;

    let budget = AUTO_EXPAND_BUDGET - architecture.nodes.length;
    const next = new Set(expanded);
    let opened = false;

    for (const node of architecture.nodes) {
      if (!node.expandable || !node.path || node.expanded) continue;
      // The project's own blocks open regardless of budget: their contents are
      // the whole point of this level.
      const isProjectBlock = !node.path.includes("/");
      const cost = node.expandableCount ?? 0;
      if (!isProjectBlock && cost > budget) continue;

      budget -= cost;
      next.add(node.path);
      opened = true;
    }

    if (opened) setExpanded(next);
    else autoExpandSettled.current = true;
  }, [loading, architecture, expanded]);

  const toggleExpand = useCallback((path: string) => {
    autoExpandSettled.current = true;
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const nodes = useMemo<ArchitectureDiagramNode[]>(
    () =>
      layoutArchitecture(architecture.nodes, architecture.edges).map(
        (node) => ({
          id: node.id,
          frame:
            node.type === "vpc"
              ? ("vpc" as const)
              : node.type === "module"
                ? ("module" as const)
                : node.type === "subnet"
                  ? node.icon === "subnet-public"
                    ? ("subnet-public" as const)
                    : ("subnet-private" as const)
                  : null,
          label: node.label,
          sublabel: node.sublabel,
          icon: node.icon,
          count: node.addresses.length,
          moduleCall: node.isModuleCall,
          expandPath: node.expandable ? node.path : undefined,
          expandableCount: node.expandableCount,
          expanded: node.expanded,
          parentId: node.parentId,
          position: node.position,
          width: node.width,
          height: node.height,
        }),
      ),
    [architecture],
  );

  const handleNodeClick = useCallback(
    (node: ArchitectureDiagramNode) => {
      setSelectedId((current) => (current === node.id ? null : node.id));

      // Only the project's own blocks exist on the canvas; anything nested
      // belongs to another repository and has nothing to inspect here.
      const isProjectBlock =
        node.id.startsWith("module.") && !node.id.includes("/");
      if (isProjectBlock) onSelectModule?.(node.id.slice("module.".length));
    },
    [onSelectModule],
  );

  if (loading) return <Skeleton className="h-full w-full" />;

  if (nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center">
        <LayoutGrid className="h-8 w-8 text-muted-foreground" />
        <p className="font-medium text-sm">Nothing to draw yet</p>
        <p className="max-w-md text-muted-foreground text-xs">
          Add modules on the detail level; this view then shows the AWS services
          they deploy and how they connect.
        </p>
      </div>
    );
  }

  return (
    <ArchitectureDiagram
      className={className}
      edges={architecture.edges}
      fill
      highlightedNodeId={selectedId}
      nodePositions={positions}
      nodes={nodes}
      onNodeClick={handleNodeClick}
      onNodePositionsChange={(moved) =>
        setPositions((current) => ({ ...current, ...moved }))
      }
      onPaneClick={() => setSelectedId(null)}
      onResetLayout={() => setPositions({})}
      onToggleExpand={toggleExpand}
    />
  );
}
