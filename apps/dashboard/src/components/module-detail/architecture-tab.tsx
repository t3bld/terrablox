"use client";

import {
  ArchitectureDiagram,
  type ArchitectureDiagramNode,
} from "@terrablox/graph";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LayoutGrid,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GraphLayout,
  graphLayoutsEqual,
  parseGraphLayout,
  pruneGraphLayout,
} from "@/lib/graph-layout";
import type {
  ArchitectureModuleCall,
  NestedModuleData,
} from "@/lib/terraform/architecture-graph";
import {
  buildArchitecture,
  resourceAddress,
} from "@/lib/terraform/architecture-graph";
import { layoutArchitecture } from "@/lib/terraform/architecture-layout";
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

/**
 * The subset of a resource the architecture endpoint returns. Narrower than
 * `ModuleResourceDto` on purpose: claiming the full shape would let a reader of
 * this file use `id` or `providerUrl`, which the endpoint does not send.
 */
type NestedResource = Pick<
  ModuleResourceDto,
  | "kind"
  | "resourceType"
  | "resourceName"
  | "providerName"
  | "sourceFile"
  | "resourceUrl"
  | "resourceDescription"
>;

interface NestedModule {
  id: string;
  name: string;
  versionTag: string | null;
  resources: NestedResource[];
  references: ModuleReferenceDto[];
  moduleCalls: {
    name: string;
    source: string | null;
    linkedModule: {
      moduleId: string;
      exactVersion: boolean;
      requestedRef: string | null;
    } | null;
  }[];
}

interface NestedResponse {
  rootId: string;
  modules: Record<string, NestedModule>;
}

/**
 * Opening the first level automatically is right for a wrapper that draws
 * almost nothing itself, and wrong for one that calls twenty modules. The
 * budget decides between those cases instead of asking the reader to.
 */
const AUTO_EXPAND_BUDGET = 14;

interface ArchitectureTabProps {
  moduleId: string;
  resources: ModuleResourceDto[];
  references: ModuleReferenceDto[];
  /**
   * Wrapper repositories build almost nothing themselves — their architecture
   * *is* the set of modules they call, so those are drawn as boxes too.
   */
  dependencies?: ModuleDependencyDto[];
}

const KIND_LABELS: Record<string, string> = {
  vpc: "VPC",
  subnet: "Subnet",
  module: "Module",
  service: "Service",
};

/**
 * Where a box on the diagram came from: which module declared it, and under
 * what address inside that module.
 *
 * Nested boxes carry their call path in front of every address, so
 * `module.vpc/aws_subnet.private` is a subnet belonging to whatever
 * `module "vpc"` resolves to — not to the module being viewed. Splitting that
 * apart is what lets the panel show the same detail for a box three levels
 * down as for one the module declares itself.
 */
interface ResolvedAddress {
  /** The address as Terraform would write it, without the call path. */
  local: string;
  /** Name of the module that declares it, when that is not the one on screen. */
  fromModule?: string;
  /** Link to that module, when it was imported. */
  fromModuleId?: string;
  resource?: NestedResource;
  /** For a `module "x"` box, the source the call points at. */
  moduleSource?: string;
}

const OMISSION_LABELS: Record<string, string> = {
  "data-source": "Data sources — lookups, not deployed infrastructure",
  detail: "Supporting detail — routing, IAM, listeners, certificates, keys",
  "unknown-type": "No architecture mapping yet",
};

export function ArchitectureTab({
  moduleId,
  resources,
  references,
  dependencies,
}: ArchitectureTabProps) {
  const [showOmissions, setShowOmissions] = useState(false);
  const [nested, setNested] = useState<NestedResponse | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const autoExpandedFor = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    setNested(null);
    autoExpandedFor.current = null;

    fetch(`/api/modules/${moduleId}/architecture`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: NestedResponse | null) => {
        if (current && data) setNested(data);
      })
      // A failure here only costs the ability to expand; the module's own
      // diagram still draws from the props it already has.
      .catch(() => undefined);

    return () => {
      current = false;
    };
  }, [moduleId]);

  const moduleCalls = useMemo<ArchitectureModuleCall[]>(
    () =>
      (dependencies ?? [])
        .filter((d) => d.source)
        .map((d) => ({
          name: d.name,
          source: d.source as string,
          moduleId: d.linkedModule?.moduleId,
          requestedRef:
            d.linkedModule && !d.linkedModule.exactVersion
              ? d.linkedModule.requestedRef
              : null,
        })),
    [dependencies],
  );

  const moduleFor = useCallback(
    (call: ArchitectureModuleCall): NestedModuleData | null => {
      const target = call.moduleId ? nested?.modules[call.moduleId] : null;
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
            requestedRef:
              c.linkedModule && !c.linkedModule.exactVersion
                ? c.linkedModule.requestedRef
                : null,
          })),
      };
    },
    [nested],
  );

  const graph = useMemo(
    () =>
      buildArchitecture(
        resources,
        references,
        moduleCalls,
        nested ? { expanded: expanded as Set<string>, moduleFor } : undefined,
      ),
    [resources, references, moduleCalls, nested, expanded, moduleFor],
  );

  useEffect(() => {
    if (!nested || autoExpandedFor.current === moduleId) return;
    autoExpandedFor.current = moduleId;

    // Greedy over the first level only: enough to give a wrapper a picture,
    // never enough to bury the reader.
    let budget = AUTO_EXPAND_BUDGET - graph.nodes.length;
    const open = new Set<string>();

    for (const node of graph.nodes) {
      if (!node.expandable || !node.path) continue;
      const cost = node.expandableCount ?? 0;
      if (cost > budget) continue;
      budget -= cost;
      open.add(node.path);
    }

    if (open.size > 0) setExpanded(open);
  }, [nested, moduleId, graph]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const clearSelection = useCallback(() => setSelectedId(null), []);

  const nodesById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );

  // Clicking the same box again puts the panel away, so the tile that opened it
  // is also the tile that closes it.
  const handleNodeClick = useCallback((node: ArchitectureDiagramNode) => {
    setSelectedId((current) => (current === node.id ? null : node.id));
  }, []);

  // A box can disappear under the reader — collapsing a module takes its whole
  // contents off the canvas — and a panel describing something no longer drawn
  // would be a dead end.
  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null;
  useEffect(() => {
    if (selectedId && !nodesById.has(selectedId)) setSelectedId(null);
  }, [selectedId, nodesById]);

  /**
   * Splits a diagram address into the module that declares it and the address
   * inside that module, then finds the resource behind it.
   *
   * The call path is walked rather than guessed: the same repository reached
   * through two different calls is two boxes, and only the chain of names says
   * which one a given address belongs to.
   */
  const resolveAddress = useCallback(
    (prefixed: string): ResolvedAddress => {
      const segments = prefixed.split("/");
      const local = segments.pop() ?? prefixed;

      let currentId = nested?.rootId;
      let currentName: string | undefined;

      for (const segment of segments) {
        const call = currentId
          ? nested?.modules[currentId]?.moduleCalls.find(
              (candidate) => `module.${candidate.name}` === segment,
            )
          : undefined;

        // An unresolvable chain still yields the local address, which is more
        // useful than refusing to say anything about the box.
        if (!call?.linkedModule) return { local };

        currentId = call.linkedModule.moduleId;
        currentName = nested?.modules[currentId]?.name;
      }

      const isRoot = segments.length === 0;
      const pool: NestedResource[] | undefined = isRoot
        ? resources
        : currentId
          ? nested?.modules[currentId]?.resources
          : undefined;

      const declaring = isRoot ? undefined : currentId;
      const calls = local.startsWith("module.")
        ? isRoot
          ? (dependencies ?? []).map((d) => ({
              name: d.name,
              source: d.source,
            }))
          : declaring
            ? nested?.modules[declaring]?.moduleCalls
            : undefined
        : undefined;

      return {
        local,
        fromModule: isRoot ? undefined : currentName,
        fromModuleId: declaring,
        resource: pool?.find(
          (candidate) => resourceAddress(candidate) === local,
        ),
        moduleSource:
          calls?.find((call) => `module.${call.name}` === local)?.source ??
          undefined,
      };
    },
    [nested, resources, dependencies],
  );

  /** A box's name as the reader sees it on the canvas, for the neighbour lists. */
  const labelFor = useCallback(
    (id: string) => {
      const node = nodesById.get(id);
      if (!node) return id;
      return node.sublabel ? `${node.label} · ${node.sublabel}` : node.label;
    },
    [nodesById],
  );

  /**
   * Neighbours of the selected box, read from the edges actually drawn. Unlike
   * the Connections view there is no filter to look past here: a connection
   * missing from this list is missing because it lives inside a module that is
   * still collapsed, and the panel says so rather than listing boxes that are
   * nowhere on screen.
   */
  const connections = useMemo(() => {
    if (!selectedId) return { feeds: [], fedBy: [] };

    const build = (
      matches: (edge: (typeof graph.edges)[number]) => boolean,
    ) => {
      const seen = new Map<
        string,
        { address: string; label: string; note?: string }
      >();

      for (const edge of graph.edges) {
        if (!matches(edge)) continue;
        const other = edge.source === selectedId ? edge.target : edge.source;
        if (seen.has(other)) continue;

        seen.set(other, {
          address: other,
          label: labelFor(other),
          // Routed connections would otherwise look invented: nothing in the
          // Terraform says CloudFront points at a load balancer, an
          // `aws_cloudfront_vpc_origin` between them does.
          note: edge.via?.length
            ? `via ${edge.via.map((address) => address.split("/").pop()).join(" → ")}`
            : undefined,
        });
      }

      return [...seen.values()].sort((a, b) =>
        a.label.localeCompare(b.label, "en", { numeric: true }),
      );
    };

    return {
      feeds: build((edge) => edge.source === selectedId),
      fedBy: build((edge) => edge.target === selectedId),
    };
  }, [selectedId, graph.edges, labelFor]);

  /**
   * What the panel has to show about the selected box, split by what it is.
   *
   * A box is not always one resource: an HTTP API is five Terraform blocks
   * drawn as one tile, and a wrapper's own resources are folded into the module
   * call they configure. The tile shows only a "×5", which tells the reader
   * that something was folded but not what — this is where they find out.
   */
  const detail = useMemo(() => {
    if (!selected) return null;

    const all = selected.addresses.map(resolveAddress);

    // A module call's first address is the call itself; anything after it was
    // folded in from the caller.
    const call = selected.isModuleCall ? all[0] : undefined;
    const rest = selected.isModuleCall ? all.slice(1) : all;

    return {
      call,
      resources: rest,
      /** Set only when the box stands for exactly one resource. */
      only: !call && rest.length === 1 ? rest[0] : undefined,
      declaredBy: call?.fromModule ?? rest[0]?.fromModule,
    };
  }, [selected, resolveAddress]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  // Only module calls that resolved to an imported module become links, so a
  // tile never promises a page that does not exist.
  const hrefByAddress = useMemo(() => {
    const map = new Map<string, string>();
    for (const dependency of dependencies ?? []) {
      if (dependency.linkedModule) {
        map.set(
          `module.${dependency.name}`,
          `/modules/${dependency.linkedModule.moduleId}#architecture`,
        );
      }
    }
    return map;
  }, [dependencies]);

  const nodes = useMemo<ArchitectureDiagramNode[]>(
    () =>
      layoutArchitecture(graph.nodes, graph.edges).map((node) => ({
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
        href: node.isModuleCall ? hrefByAddress.get(node.id) : undefined,
        expandPath: node.expandable ? node.path : undefined,
        expandableCount: node.expandableCount,
        expanded: node.expanded,
        versionMismatch: node.versionMismatch,
        parentId: node.parentId,
        position: node.position,
        width: node.width,
        height: node.height,
      })),
    [graph.nodes, graph.edges, hrefByAddress],
  );

  // Kept apart from the Connections view's layout: both belong to this module
  // but their node ids are unrelated, so they are stored under separate keys.
  const LAYOUT_URL = `/api/modules/${moduleId}/graph-layout?graph=architecture`;

  const [layout, setLayout] = useState<GraphLayout>({});
  // Set once the user drags or resets, so a slow GET can never overwrite what
  // they just did. Deliberately *not* a "load finished" flag: React's strict
  // mode runs the effect twice, and the aborted first request would then
  // discard the answer of the second.
  const userTouchedLayout = useRef(false);

  useEffect(() => {
    userTouchedLayout.current = false;
    setLayout({});

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(LAYOUT_URL, {
          signal: controller.signal,
        });
        if (!response.ok) return;

        const body = (await response.json()) as { positions?: unknown };
        if (controller.signal.aborted || userTouchedLayout.current) return;

        setLayout(parseGraphLayout(body.positions));
      } catch {
        // A missing layout is not an error worth interrupting the user for;
        // the diagram simply stays on its computed arrangement.
      }
    })();

    return () => controller.abort();
  }, [LAYOUT_URL]);

  const handlePositionsChange = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      userTouchedLayout.current = true;

      setLayout((current) => {
        // The diagram reports only the boxes it currently draws. Merging keeps
        // the positions of anything inside a module that is collapsed again.
        const next = { ...current, ...positions };
        if (graphLayoutsEqual(current, next)) return current;

        void fetch(LAYOUT_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions: next }),
        }).catch(() => {
          // Positions are a convenience, not data the user typed. A failed
          // save must not throw away what is on screen.
        });

        return next;
      });
    },
    [LAYOUT_URL],
  );

  const handleResetLayout = useCallback(() => {
    userTouchedLayout.current = true;
    setLayout({});

    void fetch(LAYOUT_URL, { method: "DELETE" }).catch(() => {});
  }, [LAYOUT_URL]);

  /**
   * Only positions of boxes actually on the canvas reach React Flow. Passing
   * entries for the contents of a collapsed module would make the prop churn
   * on every expand without any visible effect.
   */
  const visiblePositions = useMemo(
    () =>
      pruneGraphLayout(
        layout,
        nodes.map((node) => node.id),
      ),
    [layout, nodes],
  );

  // Only the calls visible right now, so "Expand all" opens one level per
  // click. Opening every level at once could reveal a hundred boxes from a
  // single press, which is not something a reader can undo in their head.
  const expandableNow = useMemo(
    () =>
      graph.nodes
        .filter((node) => node.expandable && node.path && !node.expanded)
        .map((node) => node.path as string),
    [graph.nodes],
  );

  const grouped = useMemo(() => {
    const byReason = new Map<string, string[]>();
    for (const omission of graph.omissions) {
      const list = byReason.get(omission.reason);
      if (list) list.push(omission.address);
      else byReason.set(omission.reason, [omission.address]);
    }
    return [...byReason.entries()].map(([reason, addresses]) => ({
      reason,
      addresses: addresses.sort(),
    }));
  }, [graph.omissions]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <LayoutGrid className="h-8 w-8 text-muted-foreground" />
        <p className="font-medium text-sm">
          Nothing to draw at architecture level
        </p>
        <p className="max-w-md text-muted-foreground text-xs">
          This module declares no infrastructure that appears on an architecture
          diagram. The Connections tab shows the full resource graph.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        A high-level view of what this module deploys. Modules it calls are
        drawn as dashed boxes; supporting resources such as routing, IAM and
        listener rules are left out on purpose — see Connections for the
        complete graph.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">{graph.nodes.length} drawn</Badge>
        {graph.omissions.length > 0 ? (
          <button
            aria-expanded={showOmissions}
            className="rounded-full border px-2.5 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-secondary"
            onClick={() => setShowOmissions((open) => !open)}
            type="button"
          >
            {graph.omissions.length} not shown{showOmissions ? " ▴" : " ▾"}
          </button>
        ) : null}
        {expandableNow.length > 0 ? (
          <button
            className="rounded-full border px-2.5 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-secondary"
            onClick={() =>
              setExpanded((current) => new Set([...current, ...expandableNow]))
            }
            title="Draw the architecture of the modules this one calls"
            type="button"
          >
            Expand {expandableNow.length} module
            {expandableNow.length === 1 ? "" : "s"}
          </button>
        ) : null}
        {expanded.size > 0 ? (
          <button
            className="rounded-full border px-2.5 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-secondary"
            onClick={() => setExpanded(new Set())}
            type="button"
          >
            Collapse all ({expanded.size})
          </button>
        ) : null}
        {graph.unmappedTypes.length > 0 ? (
          <span
            className="text-amber-600 dark:text-amber-500"
            title="These have no architecture mapping yet, so they are missing from the diagram."
          >
            Unmapped: {graph.unmappedTypes.join(", ")}
          </span>
        ) : null}
      </div>

      {showOmissions ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          {grouped.map(({ reason, addresses }) => (
            <div key={reason}>
              <p className="font-medium text-xs">
                {OMISSION_LABELS[reason] ?? reason}{" "}
                <span className="text-muted-foreground">
                  ({addresses.length})
                </span>
              </p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground leading-relaxed">
                {addresses.join(" · ")}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        <ArchitectureDiagram
          className="min-w-0 flex-1"
          edges={graph.edges}
          highlightedNodeId={selectedId}
          nodePositions={visiblePositions}
          nodes={nodes}
          onNodeClick={handleNodeClick}
          onNodePositionsChange={handlePositionsChange}
          onPaneClick={clearSelection}
          onResetLayout={handleResetLayout}
          onToggleExpand={toggleExpand}
        />

        {selected && detail ? (
          <GraphDetailPanel
            badges={
              <>
                <Badge variant="outline">
                  {selected.isModuleCall
                    ? "Module call"
                    : (KIND_LABELS[selected.type] ?? selected.type)}
                </Badge>
                {selected.expanded ? (
                  <Badge variant="secondary">Expanded</Badge>
                ) : null}
              </>
            }
            onClose={clearSelection}
            subtitle={selected.sublabel}
            title={selected.label}
          >
            <dl className="divide-y">
              {detail.call ? (
                <>
                  <DetailRow label="Call" value={detail.call.local} />
                  <DetailRow label="Source" value={detail.call.moduleSource} />
                </>
              ) : null}

              {/*
                One resource gets the full treatment; several get a list below,
                because repeating four rows five times would bury the one thing
                that distinguishes them.
              */}
              {detail.only ? (
                <>
                  <DetailRow label="Address" value={detail.only.local} />
                  <DetailRow
                    label="Type"
                    value={detail.only.resource?.resourceType}
                  />
                  <DetailRow
                    label="Provider"
                    mono={false}
                    value={detail.only.resource?.providerName}
                  />
                  <DetailRow
                    label="Declared in"
                    value={detail.only.resource?.sourceFile}
                  />
                </>
              ) : null}

              {/*
                Named on every box that came from elsewhere. Without it a reader
                who has expanded two levels cannot tell which repository they
                are looking at, and would go hunting in this one.
              */}
              <DetailRow
                label="Declared by"
                mono={false}
                value={detail.declaredBy}
              />
            </dl>

            {detail.only?.resource?.resourceDescription ? (
              <p className="mt-4 text-muted-foreground text-sm">
                {detail.only.resource.resourceDescription}
              </p>
            ) : null}

            {selected.versionMismatch ? (
              <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-amber-700 text-xs dark:text-amber-400">
                This call asks for {selected.versionMismatch}, but the imported
                copy is a different version — what is drawn inside may not match
                what would actually be deployed.
              </p>
            ) : null}

            {selected.moduleId ? (
              <Button asChild className="mt-4 w-full" size="sm">
                <Link href={`/modules/${selected.moduleId}#architecture`}>
                  <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />
                  Open {selected.label}
                </Link>
              </Button>
            ) : null}

            {selected.expandable && selected.path ? (
              <Button
                className="mt-2 w-full"
                onClick={() => toggleExpand(selected.path as string)}
                size="sm"
                type="button"
                variant="outline"
              >
                {selected.expanded ? (
                  <ChevronDown className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="mr-1.5 h-3.5 w-3.5" />
                )}
                {selected.expanded
                  ? "Collapse"
                  : `Draw its ${selected.expandableCount} box${
                      selected.expandableCount === 1 ? "" : "es"
                    }`}
              </Button>
            ) : null}

            {detail.only?.resource?.resourceUrl ? (
              <Button
                asChild
                className="mt-2 w-full"
                size="sm"
                variant="outline"
              >
                <a
                  href={detail.only.resource.resourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open documentation
                </a>
              </Button>
            ) : null}

            {detail.resources.length > 1 ? (
              <div className="mt-6">
                <h5 className="mb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  Drawn as one box{" "}
                  <span className="tabular-nums opacity-70">
                    {detail.resources.length}
                  </span>
                </h5>
                <div className="space-y-1">
                  {detail.resources.map((entry) => (
                    <div
                      className="rounded-md border px-2.5 py-1.5"
                      key={entry.local}
                    >
                      <p className="break-all font-mono text-xs">
                        {entry.local}
                      </p>
                      {entry.resource?.sourceFile ? (
                        <p className="truncate text-[11px] text-muted-foreground">
                          {entry.resource.sourceFile}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-6 space-y-5">
              <ConnectionList
                emptyText="Nothing on the diagram depends on this."
                icon={<ArrowRight className="h-3.5 w-3.5" />}
                items={connections.feeds}
                onSelect={setSelectedId}
                title="Feeds"
              />
              <ConnectionList
                emptyText="Nothing on the diagram feeds this."
                icon={<ArrowLeft className="h-3.5 w-3.5" />}
                items={connections.fedBy}
                onSelect={setSelectedId}
                title="Fed by"
              />
            </div>
          </GraphDetailPanel>
        ) : null}
      </div>
    </div>
  );
}
