"use client";

import {
  ArchitectureDiagram,
  type ArchitectureDiagramNode,
} from "@terrablox/graph";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Skeleton } from "@terrablox/ui/skeleton";
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
import { parseModuleSourceRef } from "@/lib/terraform/module-link";
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
 * this file use `id`, which the endpoint does not send.
 */
type NestedResource = Pick<
  ModuleResourceDto,
  | "kind"
  | "resourceType"
  | "resourceName"
  | "providerName"
  | "providerUrl"
  | "sourceFile"
  | "conditionalOn"
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
    sourceKind: string | null;
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
  /**
   * Where this module's own files can be read, so a declaration can be opened.
   *
   * Passed in rather than derived here because it takes the module's clone URL,
   * imported ref and analysed root folder, all of which live on the detail page.
   * Only this module's files: a box drawn from an expanded submodule belongs to
   * another repository, and the nested response does not carry its URL — so those
   * are deliberately left unlinked rather than pointed at the wrong repository.
   */
  fileUrl?: (sourceFile: string) => string | null;
  /**
   * The architecture/detail switch, drawn over the diagram.
   *
   * Passed in rather than owned here because the other level needs the same
   * control, and a switch that each view drew for itself would be two switches
   * that could disagree about which one is active.
   */
  levelSwitch?: React.ReactNode;
}

const KIND_LABELS: Record<string, string> = {
  vpc: "VPC",
  subnet: "Subnet",
  module: "Module",
  service: "Service",
};

/**
 * Terraform source addresses include a forwarding prefix, subdirectory and
 * ref; the repository itself is the useful destination for a reader.
 */
function repositoryUrl(source: string | null | undefined): string | null {
  const withoutForwarder = source?.trim().replace(/^[a-z][a-z0-9+.-]*::/i, "");
  if (!withoutForwarder?.startsWith("http")) return null;

  const withoutQuery = withoutForwarder.split("?", 1)[0] ?? "";
  const schemeEnd = withoutQuery.indexOf("://") + 3;
  const subdirectory = withoutQuery.indexOf("//", schemeEnd);

  return subdirectory === -1
    ? withoutQuery
    : withoutQuery.slice(0, subdirectory);
}

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
  /** How to read that source; without it a registry address parses wrongly. */
  moduleSourceKind?: string | null;
}

export function ArchitectureTab({
  moduleId,
  resources,
  references,
  dependencies,
  fileUrl,
  levelSwitch,
}: ArchitectureTabProps) {
  const [nested, setNested] = useState<NestedResponse | null>(null);
  const [nestedReady, setNestedReady] = useState(false);
  const [architectureReady, setArchitectureReady] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const autoExpandedFor = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    setNested(null);
    setNestedReady(false);
    setArchitectureReady(false);
    autoExpandedFor.current = null;

    fetch(`/api/modules/${moduleId}/architecture`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: NestedResponse | null) => {
        if (!current) return;
        setNested(data);
        setNestedReady(true);
      })
      // A failure here only costs the ability to expand; the module's own
      // diagram still draws from the props it already has.
      .catch(() => {
        if (current) setNestedReady(true);
      });

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
          sourceKind: d.sourceKind,
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
            sourceKind: c.sourceKind,
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
    if (!nestedReady) return;
    if (!nested || autoExpandedFor.current === moduleId) {
      setArchitectureReady(true);
      return;
    }
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
    setArchitectureReady(true);
  }, [nested, nestedReady, moduleId, graph]);

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
              sourceKind: d.sourceKind,
            }))
          : declaring
            ? nested?.modules[declaring]?.moduleCalls
            : undefined
        : undefined;

      const call = calls?.find((entry) => `module.${entry.name}` === local);

      return {
        local,
        fromModule: isRoot ? undefined : currentName,
        fromModuleId: declaring,
        resource: pool?.find(
          (candidate) => resourceAddress(candidate) === local,
        ),
        moduleSource: call?.source ?? undefined,
        moduleSourceKind: call?.sourceKind ?? undefined,
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
      /**
       * The undrawn resources serving this box. Resolved through the same call
       * path as the addresses above, so a role inside a nested module reports
       * the file it is actually declared in.
       */
      supporting: (selected.attachments ?? []).map((attachment) => ({
        ...attachment,
        entries: attachment.addresses.map(resolveAddress),
      })),
    };
  }, [selected, resolveAddress]);

  /**
   * The GitHub URL for one of this module's files, or null.
   *
   * Null covers three cases that all have to behave the same way: no builder was
   * passed, the file is unknown, and the repository is not one we can address.
   * The callers then render plain text, which is what they did before any of this
   * was linkable.
   */
  const fileHref = useCallback(
    (sourceFile: string | null | undefined) =>
      sourceFile ? (fileUrl?.(sourceFile) ?? null) : null,
    [fileUrl],
  );

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
        attachments: node.attachments?.map((attachment) => ({
          service: attachment.service,
          icon: attachment.icon,
          count: attachment.addresses.length,
        })),
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
      } finally {
        if (!controller.signal.aborted) setLayoutReady(true);
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

  if (!architectureReady || !layoutReady) {
    return <Skeleton className="h-[calc(100vh-25rem)] min-h-[24rem] w-full" />;
  }

  if (graph.nodes.length === 0) {
    return (
      // Sized like the canvas it stands in for and drawn in nothing but muted
      // tones. Given a border, a filled icon and a semibold line, an empty state
      // reads as a notice — as though something had gone wrong — when all it has
      // to say is that there is nothing here.
      <div className="flex min-h-[18rem] flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed bg-muted/20 py-16 text-center">
        <LayoutGrid className="h-7 w-7 text-muted-foreground/40" />
        <p className="text-muted-foreground text-sm">Nothing to draw</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
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
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* `relative` so the switch can sit on the drawing rather than above it:
            the level belongs to the diagram, and the diagram owns the area. */}
        <div className="relative flex min-w-0 flex-1">
          {levelSwitch ? (
            <div className="absolute top-3 left-3 z-10">{levelSwitch}</div>
          ) : null}

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
        </div>

        {selected && detail ? (
          <GraphDetailPanel
            badges={
              selected.isModuleCall ? (
                selected.expanded ? (
                  <Badge variant="secondary">Expanded</Badge>
                ) : undefined
              ) : (
                <>
                  {/* "Service" is dropped: it is the catch-all kind, so the badge
                      said no more than the icon and the title already do. A VPC or
                      a subnet badge still earns its place, because those boxes
                      contain others and the kind is why. */}
                  {selected.type === "service" ? null : (
                    <Badge variant="outline">
                      {KIND_LABELS[selected.type] ?? selected.type}
                    </Badge>
                  )}
                  {selected.expanded ? (
                    <Badge variant="secondary">Expanded</Badge>
                  ) : null}
                </>
              )
            }
            onClose={clearSelection}
            subtitle={selected.isModuleCall ? undefined : selected.sublabel}
            title={selected.label}
          >
            <dl className="divide-y">
              {detail.call ? (
                <>
                  <DetailRow label="Module" value={detail.call.local} />
                  <DetailRow
                    href={repositoryUrl(detail.call.moduleSource)}
                    label="Repository"
                    mono={false}
                    value={
                      parseModuleSourceRef(
                        detail.call.moduleSource,
                        detail.call.moduleSourceKind,
                      )?.repo ?? detail.call.moduleSource
                    }
                  />
                  <DetailRow
                    label="Version"
                    value={
                      parseModuleSourceRef(
                        detail.call.moduleSource,
                        detail.call.moduleSourceKind,
                      )?.ref
                    }
                  />
                </>
              ) : null}

              {/*
                One resource gets the full treatment; several get a list below,
                because repeating four rows five times would bury the one thing
                that distinguishes them.
              */}
              {detail.only ? (
                <>
                  {/* The address carries the type — `aws_sfn_state_machine.this`
                      is the type and the label — so a separate Type row repeated
                      half of it. The link that used to be a button at the bottom
                      of the panel lives on the address instead, where the thing
                      being documented is named. */}
                  <DetailRow
                    href={detail.only.resource?.resourceUrl}
                    label="Address"
                    value={detail.only.local}
                  />
                  <DetailRow
                    href={detail.only.resource?.providerUrl}
                    label="Provider"
                    mono={false}
                    value={detail.only.resource?.providerName}
                  />
                  <DetailRow
                    href={fileHref(detail.only.resource?.sourceFile)}
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

            {/* The subnet is still drawn public — the code does route it out. This
                only says the route is behind a condition, which is what a reader
                needs to check against their own inputs. Whether the condition is
                true by default cannot be known without evaluating every variable
                and local it names. */}
            {selected.publicRouteCondition ? (
              <p className="mt-4 rounded-md border bg-muted/40 px-2.5 py-2 text-muted-foreground text-xs">
                Its route to the internet gateway is conditional:{" "}
                <code className="break-all font-mono">
                  {selected.publicRouteCondition}
                </code>{" "}
                — so whether this subnet is really public depends on the values
                you pass in.
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

            {/*
              The thirteen IAM resources this module spends most of its lines on
              live here. They are not drawn, because an IAM role is a property of
              the state machine rather than a component beside it — but "not
              drawn" must not mean "not findable", or the reader is left counting
              boxes against a resource list that will never agree.
            */}
            {detail.supporting.length > 0 ? (
              <div className="mt-6">
                <h5 className="mb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  Supporting resources{" "}
                  <span className="tabular-nums opacity-70">
                    {detail.supporting.reduce(
                      (sum, group) => sum + group.entries.length,
                      0,
                    )}
                  </span>
                </h5>
                <div className="space-y-3">
                  {detail.supporting.map((group) => (
                    <div key={group.service}>
                      <p className="mb-1 flex items-center gap-1.5 font-medium text-xs">
                        {group.icon ? (
                          // biome-ignore lint/performance/noImgElement: the AWS icons are vendored SVGs, which next/image passes through unchanged
                          <img
                            alt=""
                            className="h-3.5 w-3.5 shrink-0"
                            src={`/aws-icons/${group.icon}.svg`}
                          />
                        ) : null}
                        {group.service}
                        <span className="tabular-nums text-muted-foreground">
                          {group.entries.length}
                        </span>
                        {group.shared ? (
                          <span
                            className="rounded bg-muted px-1 py-px font-normal text-[10px] text-muted-foreground"
                            title="Another box on the diagram uses these too, so they are listed under both."
                          >
                            shared
                          </span>
                        ) : null}
                      </p>
                      {/* A link when the file is this module's, plain text when it
                          is not: an entry from an expanded submodule is declared
                          in another repository, and only the box's own repository
                          can be addressed from here. */}
                      <div className="space-y-1">
                        {group.entries.map((entry) => {
                          const href = entry.fromModule
                            ? null
                            : fileHref(entry.resource?.sourceFile);

                          const body = (
                            <>
                              <p className="break-all font-mono text-xs">
                                {entry.local}
                              </p>
                              {entry.resource?.sourceFile ? (
                                <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                                  {entry.resource.sourceFile}
                                  {href ? (
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                  ) : null}
                                </p>
                              ) : null}
                            </>
                          );

                          return href ? (
                            <a
                              className="block rounded-md border px-2.5 py-1.5 transition-colors hover:border-primary/50 hover:bg-accent"
                              href={href}
                              key={entry.local}
                              rel="noreferrer"
                              target="_blank"
                              title={`Open ${entry.resource?.sourceFile} on GitHub`}
                            >
                              {body}
                            </a>
                          ) : (
                            <div
                              className="rounded-md border px-2.5 py-1.5"
                              key={entry.local}
                            >
                              {body}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-6 space-y-5">
              {connections.feeds.length > 0 ? (
                <ConnectionList
                  emptyText="Nothing on the diagram depends on this."
                  icon={<ArrowRight className="h-3.5 w-3.5" />}
                  items={connections.feeds}
                  onSelect={setSelectedId}
                  title="Feeds"
                />
              ) : null}
              {connections.fedBy.length > 0 ? (
                <ConnectionList
                  emptyText="Nothing on the diagram feeds this."
                  icon={<ArrowLeft className="h-3.5 w-3.5" />}
                  items={connections.fedBy}
                  onSelect={setSelectedId}
                  title="Fed by"
                />
              ) : null}
            </div>
          </GraphDetailPanel>
        ) : null}
      </div>
    </div>
  );
}
