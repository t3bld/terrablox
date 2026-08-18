"use client";

import type {
  DependencyGraphEdge,
  DependencyGraphNode,
} from "@terrablox/graph/dependency-graph";
import { DependencyGraph } from "@terrablox/graph/dependency-graph";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  Network,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GraphLayout,
  graphLayoutsEqual,
  parseGraphLayout,
  pruneGraphLayout,
} from "@/lib/graph-layout";
import { shortModuleSource } from "@/lib/module-source";
import { SearchField } from "./field-primitives";
import {
  ConnectionList,
  DetailRow,
  GraphDetailPanel,
} from "./graph-detail-panel";
import type {
  ModuleDependencyDto,
  ModuleReferenceDto,
  ModuleResourceDto,
} from "./types";

interface ConnectionsTabProps {
  moduleId: string;
  references: ModuleReferenceDto[];
  resources: ModuleResourceDto[];
  dependencies: ModuleDependencyDto[];
}

/**
 * The Terraform address of a resource block, e.g. `aws_subnet.public` or
 * `data.aws_ami.this`. Must match how the analyzer builds reference endpoints,
 * because edges are stored as addresses rather than foreign keys.
 */
function resourceAddress(resource: ModuleResourceDto): string {
  const base = resource.resourceName
    ? `${resource.resourceType}.${resource.resourceName}`
    : resource.resourceType;

  return resource.kind === "data" ? `data.${base}` : base;
}

interface GraphModel {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  /** Nodes that exist in the module but take part in no reference. */
  isolatedCount: number;
}

function buildGraph(
  references: ModuleReferenceDto[],
  resources: ModuleResourceDto[],
  dependencies: ModuleDependencyDto[],
  { includeIsolated }: { includeIsolated: boolean },
): GraphModel {
  const connected = new Set<string>();
  for (const ref of references) {
    connected.add(ref.fromAddress);
    connected.add(ref.toAddress);
  }

  const nodes: DependencyGraphNode[] = [];
  const known = new Set<string>();
  let isolatedCount = 0;

  for (const resource of resources) {
    const address = resourceAddress(resource);
    // A module may declare the same address in several files; the graph needs
    // exactly one node per address or React Flow drops the duplicates.
    if (known.has(address)) continue;
    known.add(address);

    if (!connected.has(address)) {
      isolatedCount += 1;
      if (!includeIsolated) continue;
    }

    nodes.push({
      id: address,
      label: address,
      kind: resource.kind === "data" ? "data" : "resource",
      // No description on purpose: the provider already shows as the node's
      // group badge, and a fourth line of text overflows the node frame.
      group: resource.providerName,
      metadata: {
        Type: resource.resourceType,
        File: resource.sourceFile,
      },
      url: resource.resourceUrl ?? undefined,
    });
  }

  for (const dependency of dependencies) {
    const address = `module.${dependency.name}`;
    if (known.has(address)) continue;
    known.add(address);

    if (!connected.has(address)) {
      isolatedCount += 1;
      if (!includeIsolated) continue;
    }

    nodes.push({
      id: address,
      // The `module.` prefix repeats on every node of this kind and the badge
      // already says "Module calls". The full address stays available as the
      // node id and is shown in the detail panel.
      label: dependency.name,
      kind: "external-module",
      group: "Module calls",
      metadata: {
        Source: shortModuleSource(dependency.source, dependency.sourceKind),
        Version: dependency.version,
      },
      url: dependency.registryUrl ?? undefined,
    });
  }

  const rendered = new Set(nodes.map((n) => n.id));

  const edges: DependencyGraphEdge[] = [];
  for (const ref of references) {
    if (!rendered.has(ref.fromAddress) || !rendered.has(ref.toAddress))
      continue;

    edges.push({
      id: `${ref.toAddress}->${ref.fromAddress}`,
      // Stored as dependent -> dependency, drawn the other way round so the
      // arrow reads as data flow: the VPC feeds the subnet, not vice versa.
      source: ref.toAddress,
      target: ref.fromAddress,
      ...(ref.attributes[0] ? { label: ref.attributes[0] } : {}),
    });
  }

  return { nodes, edges, isolatedCount };
}

/** The node kinds the graph distinguishes, in legend order. */
const nodeKindFilters = [
  { kind: "resource", label: "Resources", swatch: "border-border bg-card" },
  {
    kind: "data",
    label: "Data sources",
    swatch: "border-dashed border-muted-foreground/50 bg-card",
  },
  {
    kind: "external-module",
    label: "Module calls",
    swatch: "border-secondary bg-secondary",
  },
] as const satisfies ReadonlyArray<{
  kind: NonNullable<DependencyGraphNode["kind"]>;
  label: string;
  swatch: string;
}>;

type FilterableNodeKind = (typeof nodeKindFilters)[number]["kind"];

/**
 * Doubles as legend and filter: the swatch explains what a node of this kind
 * looks like, the button toggles it. Disabled kinds keep their entry visible so
 * the graph never silently drops a category.
 *
 * Styled to match the segmented filters on the inputs tab, which is why it
 * carries no border of its own — it sits inside a bordered fieldset.
 */
function LegendToggle({
  swatch,
  label,
  count,
  enabled,
  disabled,
  onToggle,
}: {
  swatch: string;
  label: string;
  count: number;
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      aria-pressed={enabled}
      className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground"
      } ${disabled ? "" : "hover:bg-accent hover:text-accent-foreground"}`}
      disabled={disabled}
      onClick={onToggle}
      title={
        disabled
          ? `No ${label.toLowerCase()} in this module`
          : enabled
            ? `Hide ${label.toLowerCase()}`
            : `Show ${label.toLowerCase()}`
      }
      type="button"
    >
      <span
        className={`inline-block h-3 w-3 shrink-0 rounded-sm border ${swatch} ${
          enabled ? "" : "opacity-40"
        }`}
      />
      <span className={enabled ? undefined : "line-through"}>{label}</span>
      <span className="tabular-nums opacity-60">{count}</span>
    </button>
  );
}

/** One label/value line; omitted entirely when there is nothing to show. */
const kindLabels: Record<string, string> = {
  resource: "Resource",
  data: "Data source",
  "external-module": "Module call",
  module: "This module",
};

export function ConnectionsTab({
  moduleId,
  references,
  resources,
  dependencies,
}: ConnectionsTabProps) {
  const [selected, setSelected] = useState<DependencyGraphNode | null>(null);
  const [includeIsolated, setIncludeIsolated] = useState(false);
  const [query, setQuery] = useState("");

  const full = useMemo(
    () => buildGraph(references, resources, dependencies, { includeIsolated }),
    [references, resources, dependencies, includeIsolated],
  );

  /**
   * Module calls are the default view: they describe what the module composes,
   * which is the question this tab usually answers. Resources and data sources
   * start hidden — but only if there are module calls to fall back on, since an
   * empty canvas on open would look like a failed analysis rather than a filter.
   */
  const [hiddenKinds, setHiddenKinds] = useState<
    ReadonlySet<FilterableNodeKind>
  >(() =>
    full.nodes.some((node) => node.kind === "external-module")
      ? new Set<FilterableNodeKind>(["resource", "data"])
      : new Set<FilterableNodeKind>(),
  );

  const countsByKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of full.nodes) {
      counts.set(
        node.kind ?? "resource",
        (counts.get(node.kind ?? "resource") ?? 0) + 1,
      );
    }
    return counts;
  }, [full]);

  /**
   * Kind filtering runs before the search so a search only ever pulls in
   * neighbours the user has not hidden.
   */
  const byKind = useMemo(() => {
    if (hiddenKinds.size === 0) return full;

    const kept = full.nodes.filter(
      (node) =>
        !hiddenKinds.has((node.kind ?? "resource") as FilterableNodeKind),
    );
    const keptIds = new Set(kept.map((node) => node.id));

    return {
      ...full,
      nodes: kept,
      edges: full.edges.filter(
        (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
      ),
    };
  }, [full, hiddenKinds]);

  const needle = query.trim().toLowerCase();

  /**
   * Filtering keeps the neighbours of every match so a search still shows what
   * the matched resource is wired to — a lone node would answer nothing.
   */
  const visible = useMemo(() => {
    if (!needle) return byKind;

    const matched = new Set(
      byKind.nodes
        .filter((n) => n.id.toLowerCase().includes(needle))
        .map((n) => n.id),
    );
    if (matched.size === 0) return { ...byKind, nodes: [], edges: [] };

    const keep = new Set(matched);
    for (const edge of byKind.edges) {
      if (matched.has(edge.source)) keep.add(edge.target);
      if (matched.has(edge.target)) keep.add(edge.source);
    }

    return {
      ...byKind,
      nodes: byKind.nodes.filter((n) => keep.has(n.id)),
      edges: byKind.edges.filter(
        (e) => keep.has(e.source) && keep.has(e.target),
      ),
    };
  }, [byKind, needle]);

  const toggleKind = (kind: FilterableNodeKind) => {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

    // The detail panel would otherwise keep describing a node that is no
    // longer on the canvas.
    setSelected(null);
  };

  const [layout, setLayout] = useState<GraphLayout>({});
  const [layoutReady, setLayoutReady] = useState(false);
  // Set once the user drags or resets, so a slow GET can never overwrite what
  // they just did. Deliberately *not* a "load finished" flag: React's strict
  // mode runs the effect twice, and the aborted first request would then
  // discard the answer of the second.
  const userTouchedLayout = useRef(false);

  useEffect(() => {
    userTouchedLayout.current = false;
    setLayout({});
    setLayoutReady(false);

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/modules/${moduleId}/graph-layout`, {
          signal: controller.signal,
        });
        if (!response.ok) return;

        const body = (await response.json()) as { positions?: unknown };
        if (controller.signal.aborted || userTouchedLayout.current) return;

        setLayout(parseGraphLayout(body.positions));
      } catch {
        // A missing layout is not an error worth interrupting the user for;
        // the graph simply stays on its computed arrangement.
      } finally {
        if (!controller.signal.aborted) setLayoutReady(true);
      }
    })();

    return () => controller.abort();
  }, [moduleId]);

  const persistLayout = useCallback(
    (next: GraphLayout) => {
      void fetch(`/api/modules/${moduleId}/graph-layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: next }),
      }).catch(() => {
        // Positions are a convenience, not data the user typed. A failed save
        // must not throw away what is on screen.
      });
    },
    [moduleId],
  );

  const handlePositionsChange = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      userTouchedLayout.current = true;

      setLayout((current) => {
        // The graph reports only the nodes it currently renders. Merging keeps
        // the positions of nodes hidden by a filter or the search box.
        const next = { ...current, ...positions };
        if (graphLayoutsEqual(current, next)) return current;

        persistLayout(next);
        return next;
      });
    },
    [persistLayout],
  );

  const handleResetLayout = useCallback(() => {
    userTouchedLayout.current = true;
    setLayout({});

    void fetch(`/api/modules/${moduleId}/graph-layout`, {
      method: "DELETE",
    }).catch(() => {});
  }, [moduleId]);

  /**
   * Only positions of nodes that are actually on the canvas reach React Flow.
   * Passing entries for filtered-out nodes would make the prop churn on every
   * filter change without any visible effect.
   */
  const visiblePositions = useMemo(
    () =>
      pruneGraphLayout(
        layout,
        visible.nodes.map((node) => node.id),
      ),
    [layout, visible.nodes],
  );

  const selectedUrl =
    typeof selected?.["url"] === "string" ? selected["url"] : null;

  /**
   * Backs the detail panel with the records the graph nodes were built from —
   * the nodes themselves only carry what fits on a card.
   */
  const detailsByAddress = useMemo(() => {
    const map = new Map<
      string,
      { resource?: ModuleResourceDto; dependency?: ModuleDependencyDto }
    >();

    for (const resource of resources) {
      const address = resourceAddress(resource);
      if (!map.has(address)) map.set(address, { resource });
    }
    for (const dependency of dependencies) {
      const address = `module.${dependency.name}`;
      if (!map.has(address)) map.set(address, { dependency });
    }

    return map;
  }, [resources, dependencies]);

  const nodesById = useMemo(
    () => new Map(full.nodes.map((node) => [node.id, node])),
    [full.nodes],
  );

  const labelForAddress = useCallback(
    (address: string) =>
      nodesById.get(address)?.label ?? address.replace(/^module\./, ""),
    [nodesById],
  );

  /**
   * Read from the unfiltered graph on purpose: hiding a block type is about
   * decluttering the canvas, not about pretending the connection is gone.
   */
  const connections = useMemo(() => {
    if (!selected) return { dependsOn: [], usedBy: [] };

    const dependsOn = new Set<string>();
    const usedBy = new Set<string>();

    for (const edge of full.edges) {
      if (edge.target === selected.id) dependsOn.add(edge.source);
      if (edge.source === selected.id) usedBy.add(edge.target);
    }

    const sort = (set: Set<string>) =>
      [...set]
        .map((address) => ({ address, label: labelForAddress(address) }))
        .sort((a, b) =>
          a.label.localeCompare(b.label, "en", { numeric: true }),
        );

    return { dependsOn: sort(dependsOn), usedBy: sort(usedBy) };
  }, [selected, full.edges, labelForAddress]);

  const clearSelection = useCallback(() => setSelected(null), []);

  const selectByAddress = useCallback(
    (address: string) => {
      const node = nodesById.get(address);
      if (node) setSelected(node);
    },
    [nodesById],
  );

  const selectedDetail = selected
    ? detailsByAddress.get(selected.id)
    : undefined;

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  if (!layoutReady) {
    return <Skeleton className="h-[calc(100vh-25rem)] min-h-[24rem] w-full" />;
  }

  return (
    <div className="space-y-4">
      {/*
        Wraps rather than shrinks: this fieldset is noticeably wider than the
        one on the inputs tab, so on a mid-width viewport it would squeeze the
        search box down to a few characters instead of moving to its own line.
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex min-w-[16rem] flex-1">
          <SearchField
            onChange={setQuery}
            placeholder="Filter modules…"
            value={query}
          />
        </div>

        <fieldset
          aria-label="Filter by block type"
          className="flex flex-wrap items-center gap-1 rounded-md border p-1"
        >
          <SlidersHorizontal className="mx-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {nodeKindFilters.map((filter) => (
            <LegendToggle
              count={countsByKind.get(filter.kind) ?? 0}
              disabled={(countsByKind.get(filter.kind) ?? 0) === 0}
              enabled={!hiddenKinds.has(filter.kind)}
              key={filter.kind}
              label={filter.label}
              onToggle={() => toggleKind(filter.kind)}
              swatch={filter.swatch}
            />
          ))}
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {full.isolatedCount > 0 || includeIsolated ? (
          <Button
            onClick={() => setIncludeIsolated((prev) => !prev)}
            size="sm"
            type="button"
            variant={includeIsolated ? "secondary" : "outline"}
          >
            {includeIsolated ? "Hide unconnected" : "Show unconnected"}
          </Button>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{visible.nodes.length} nodes</Badge>
          <Badge variant="secondary">{visible.edges.length} connections</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <DependencyGraph
          className="h-[calc(100vh-28rem)] min-h-[26rem] min-w-0 flex-1"
          edges={visible.edges}
          // A module with dozens of resources cannot be both fully visible and
          // legible. The overview wins by default; the filter above and the zoom
          // controls restore detail.
          fitViewMinZoom={0.05}
          emptyState={
            <div className="flex flex-col items-center justify-center gap-2 text-center">
              <Network className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {references.length === 0
                  ? "No connections were detected. Re-import this module to analyse its resource references."
                  : byKind.nodes.length === 0
                    ? "Every block type is hidden. Re-enable one above to see the graph."
                    : "Nothing matches the current filter."}
              </p>
            </div>
          }
          // Tied to the detail panel's selection so the two can never disagree
          // about which block is being inspected.
          highlightedNodeId={selected?.id ?? null}
          nodes={visible.nodes}
          nodePositions={visiblePositions}
          onNodeClick={setSelected}
          onNodePositionsChange={handlePositionsChange}
          onPaneClick={clearSelection}
          onResetLayout={handleResetLayout}
          showMiniMap={visible.nodes.length > 12}
        />

        {selected ? (
          <GraphDetailPanel
            badges={
              <Badge variant="outline">
                {kindLabels[selected.kind ?? "resource"] ?? selected.kind}
              </Badge>
            }
            onClose={clearSelection}
            subtitle={selected.group}
            title={selected.label}
          >
            <dl className="divide-y">
              <DetailRow label="Address" value={selected.id} />

              {selectedDetail?.dependency ? (
                <>
                  <DetailRow
                    label="Source"
                    value={selectedDetail.dependency.source}
                  />
                  <DetailRow
                    label="Version"
                    value={selectedDetail.dependency.version}
                  />
                  <DetailRow
                    label="Source kind"
                    mono={false}
                    value={selectedDetail.dependency.sourceKind}
                  />
                  <DetailRow
                    label="Declared in"
                    value={selectedDetail.dependency.sourceFile}
                  />
                </>
              ) : null}

              {selectedDetail?.resource ? (
                <>
                  <DetailRow
                    label="Type"
                    value={selectedDetail.resource.resourceType}
                  />
                  <DetailRow
                    label="Name"
                    value={selectedDetail.resource.resourceName}
                  />
                  <DetailRow
                    label="Provider"
                    value={selectedDetail.resource.providerName}
                  />
                  <DetailRow
                    label="Declared in"
                    value={selectedDetail.resource.sourceFile}
                  />
                </>
              ) : null}
            </dl>

            {selectedDetail?.resource?.resourceDescription ? (
              <p className="mt-4 text-sm text-muted-foreground">
                {selectedDetail.resource.resourceDescription}
              </p>
            ) : null}

            {selectedDetail?.dependency?.linkedModule ? (
              <div className="mt-4">
                <Button asChild className="w-full" size="sm" variant="default">
                  <Link
                    href={`/modules/${selectedDetail.dependency.linkedModule.moduleId}`}
                  >
                    <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />
                    Open {selectedDetail.dependency.linkedModule.name}
                  </Link>
                </Button>
                {selectedDetail.dependency.linkedModule.exactVersion ? null : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Version{" "}
                    {selectedDetail.dependency.linkedModule.requestedRef} is not
                    imported — opens{" "}
                    {selectedDetail.dependency.linkedModule.versionTag ??
                      "the latest import"}{" "}
                    instead.
                  </p>
                )}
              </div>
            ) : null}

            {selectedUrl ? (
              <Button
                asChild
                className="mt-4 w-full"
                size="sm"
                variant="outline"
              >
                <a href={selectedUrl} rel="noreferrer" target="_blank">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open documentation
                </a>
              </Button>
            ) : null}

            <div className="mt-6 space-y-5">
              <ConnectionList
                emptyText="References nothing else in this module."
                icon={<ArrowRight className="h-3.5 w-3.5" />}
                items={connections.dependsOn}
                onSelect={selectByAddress}
                title="Depends on"
              />
              <ConnectionList
                emptyText="No other block references this one."
                icon={<ArrowLeft className="h-3.5 w-3.5" />}
                items={connections.usedBy}
                onSelect={selectByAddress}
                title="Used by"
              />
            </div>
          </GraphDetailPanel>
        ) : null}
      </div>

      {full.isolatedCount > 0 && !includeIsolated ? (
        <p className="text-xs text-muted-foreground">
          {full.isolatedCount} block
          {full.isolatedCount === 1 ? " is" : "s are"} hidden because
          {full.isolatedCount === 1 ? " it references" : " they reference"} no
          other block in this module.
        </p>
      ) : null}
    </div>
  );
}
