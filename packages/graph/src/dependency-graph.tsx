"use client";

import {
  applyNodeChanges,
  Background,
  Controls,
  type Edge,
  type FitViewOptions,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConnectionLegend } from "./connection-legend";
import { KeepSelectionInView } from "./keep-selection-in-view";
import {
  type DependencyGraphLayoutDirection,
  type DependencyGraphNodeKind,
  layoutDependencyGraph,
} from "./layout";
import { ResetLayoutButton } from "./reset-layout-button";

export type { DependencyGraphLayoutDirection, DependencyGraphNodeKind };
export {
  defaultDependencyGraphNodeDimensions,
  getDependencyGraphNodeDimensions,
  layoutDependencyGraph,
} from "./layout";

export type DependencyGraphMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export interface DependencyGraphNode extends Record<string, unknown> {
  id: string;
  label: string;
  kind?: DependencyGraphNodeKind;
  description?: string;
  group?: string;
  metadata?: Record<string, DependencyGraphMetadataValue>;
  width?: number;
  height?: number;
}

export interface DependencyGraphEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
}

export interface DependencyGraphProps {
  nodes: readonly DependencyGraphNode[];
  edges: readonly DependencyGraphEdge[];
  direction?: DependencyGraphLayoutDirection;
  className?: string;
  emptyState?: ReactNode;
  fitView?: boolean;
  /**
   * Lower bound for the zoom level chosen when fitting. The default keeps node
   * labels legible; graphs that are meant to be surveyed as a whole can go
   * lower and rely on zooming in instead.
   */
  fitViewMinZoom?: number;
  showMiniMap?: boolean;
  /** Fan-out size at which leaf children switch to a grid; see `layoutDependencyGraph`. */
  leafFanoutThreshold?: number;
  /** Widest rank dagre may produce before it is wrapped; see `layoutDependencyGraph`. */
  maxNodesPerRank?: number;
  /**
   * Whether nodes can be dragged. Manual positions survive until the graph
   * itself changes (filter, direction, new data), at which point the computed
   * layout takes over again.
   */
  nodesDraggable?: boolean;
  /**
   * Positions that override the computed layout, keyed by node id. Nodes
   * without an entry keep their computed position, so a partially saved layout
   * still renders sensibly.
   */
  nodePositions?: Readonly<Record<string, { x: number; y: number }>>;
  /**
   * Called with the positions of every moved node once a drag ends. Fires only
   * on drag end, not on every frame, so callers can persist without debouncing.
   */
  onNodePositionsChange?: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  /** Called when the user asks for the computed layout back. */
  onResetLayout?: () => void;
  onNodeClick?: (node: DependencyGraphNode) => void;
  /**
   * The node whose connections are picked out. Controlled from outside so the
   * highlight and the detail panel can never disagree about what is selected.
   */
  highlightedNodeId?: string | null;
  /** Called when the user clicks the empty canvas, to drop the highlight. */
  onPaneClick?: () => void;
}

type DependencyFlowNodeData = Record<string, unknown> & {
  dependencyNode: DependencyGraphNode;
  layoutDirection: DependencyGraphLayoutDirection;
};

type DependencyFlowNode = Node<DependencyFlowNodeData, DependencyGraphNodeKind>;

type GraphNodeFrameProps = {
  node: DependencyGraphNode;
  direction: DependencyGraphLayoutDirection;
  titleClassName?: string;
  frameClassName?: string;
  kindLabel: string;
};

const nodeTypes = {
  module: ModuleNode,
  resource: ResourceNode,
  data: DataSourceNode,
  "external-module": ExternalModuleNode,
} satisfies NodeTypes;

const kindLabels = {
  module: "Module",
  resource: "Resource",
  data: "Data source",
  "external-module": "External module",
} satisfies Record<DependencyGraphNodeKind, string>;

export function DependencyGraph({
  nodes,
  edges,
  direction = "LR",
  className,
  emptyState,
  fitView = true,
  fitViewMinZoom = 0.4,
  showMiniMap,
  leafFanoutThreshold,
  maxNodesPerRank,
  nodesDraggable = true,
  nodePositions,
  onNodePositionsChange,
  onResetLayout,
  onNodeClick,
  highlightedNodeId,
  onPaneClick,
}: DependencyGraphProps) {
  const renderableEdges = useMemo(() => {
    const nodeIds = new Set(nodes.map((node) => node.id));

    return edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
    );
  }, [nodes, edges]);
  const hasRenderableDependencies =
    nodes.length > 0 && (nodes.length > 1 || renderableEdges.length > 0);

  const layoutedNodes = useMemo<Array<DependencyFlowNode>>(() => {
    const handlePositions = getHandlePositions(direction);
    const positioned = layoutDependencyGraph(nodes, renderableEdges, {
      direction,
      ...(leafFanoutThreshold === undefined ? {} : { leafFanoutThreshold }),
      ...(maxNodesPerRank === undefined ? {} : { maxNodesPerRank }),
    });

    return positioned.map((node) => ({
      id: node.id,
      type: node.kind ?? "resource",
      position: node.position,
      sourcePosition: handlePositions.source,
      targetPosition: handlePositions.target,
      data: {
        dependencyNode: node,
        layoutDirection: direction,
      },
      // Declared as real node dimensions, not just CSS: React Flow computes
      // bounds (and therefore fitView) from these before it has measured the
      // DOM, and treats nodes without them as not yet initialised.
      width: node.width,
      height: node.height,
      style: {
        width: node.width,
        height: node.height,
      },
    }));
  }, [nodes, renderableEdges, direction, leafFanoutThreshold, maxNodesPerRank]);

  // Dragging needs the node set to be state, not a derived value: React Flow
  // reports moves as changes and expects the caller to persist them.
  const [flowNodes, setFlowNodes] = useState(() =>
    applyStoredPositions(layoutedNodes, nodePositions),
  );
  const [hasMovedNodes, setHasMovedNodes] = useState(false);

  const layoutSignature = useMemo(
    () => layoutedNodes.map((node) => node.id).join("|"),
    [layoutedNodes],
  );
  // Compared by value, not identity: a caller passing an inline object literal
  // would otherwise re-seed on every render and fight the user's drag.
  const positionsSignature = useMemo(
    () => serializePositions(nodePositions),
    [nodePositions],
  );

  const latest = useRef({ layoutedNodes, nodePositions });
  latest.current = { layoutedNodes, nodePositions };

  // Re-seed when the computed layout changes (filter, direction, new data) or
  // when stored positions arrive from outside — the latter happens once, after
  // the caller has loaded them.
  //
  // The two signatures stand in for `layoutedNodes` and `nodePositions`, which
  // are read through a ref: listing the objects themselves would re-seed on
  // every render of a caller that builds them inline, snapping a node back
  // mid-drag.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signatures replace the objects read via ref
  useEffect(() => {
    setFlowNodes(
      applyStoredPositions(
        latest.current.layoutedNodes,
        latest.current.nodePositions,
      ),
    );
    setHasMovedNodes(false);
  }, [layoutSignature, positionsSignature]);

  const handleNodesChange = useCallback(
    (changes: Array<NodeChange<DependencyFlowNode>>) => {
      setFlowNodes((current) => {
        const next = applyNodeChanges(changes, current);

        // Reported on drag end only: emitting per frame would make persisting
        // callers write on every mouse move.
        if (
          changes.some(
            (change) => change.type === "position" && change.dragging === false,
          )
        ) {
          onNodePositionsChange?.(collectPositions(next));
        }

        return next;
      });

      if (
        changes.some((change) => change.type === "position" && change.dragging)
      ) {
        setHasMovedNodes(true);
      }
    },
    [onNodePositionsChange],
  );

  // Only a move the reader made counts. React Flow passes an event for those
  // and nothing for its own fits, which is the distinction that matters here.
  const [viewportMoved, setViewportMoved] = useState(false);
  const handleMove = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setViewportMoved(true);
  }, []);

  const resetLayout = useCallback(() => {
    setFlowNodes(latest.current.layoutedNodes);
    setHasMovedNodes(false);
    onResetLayout?.();
  }, [onResetLayout]);

  const hasCustomLayout =
    hasMovedNodes || Object.keys(nodePositions ?? {}).length > 0;

  /**
   * Counted from the rendered edges, so the legend never promises a connection
   * that a filter has taken off the canvas.
   */
  const highlight = useMemo(() => {
    if (!highlightedNodeId) return null;

    let outgoing = 0;
    let incoming = 0;
    const neighbours = new Set<string>([highlightedNodeId]);

    for (const edge of renderableEdges) {
      if (edge.source === highlightedNodeId) {
        outgoing++;
        neighbours.add(edge.target);
      }
      if (edge.target === highlightedNodeId) {
        incoming++;
        neighbours.add(edge.source);
      }
    }

    return { outgoing, incoming, neighbours };
  }, [highlightedNodeId, renderableEdges]);

  const flowEdges = useMemo<Array<Edge>>(
    () =>
      renderableEdges.map((edge, index) => {
        // Outgoing edges animate as well as change colour; see styles.css for
        // why direction is not carried by colour alone.
        const outgoing = edge.source === highlightedNodeId;
        const incoming = edge.target === highlightedNodeId;
        const emphasis = outgoing
          ? "tbx-edge-out"
          : incoming
            ? "tbx-edge-in"
            : highlight
              ? "tbx-edge-muted"
              : "stroke-muted-foreground";

        return {
          id: edge.id ?? `${edge.source}->${edge.target}:${index}`,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          className: emphasis,
          animated: outgoing,
          labelBgPadding: [8, 4],
          labelBgBorderRadius: 6,
          labelBgStyle: {
            fill: "hsl(var(--card))",
            color: "hsl(var(--card-foreground))",
          },
          labelStyle: {
            fill: "hsl(var(--muted-foreground))",
            fontSize: 12,
            fontWeight: 500,
          },
        };
      }),
    [renderableEdges, highlightedNodeId, highlight],
  );

  /**
   * Emphasis is applied here rather than stored on the nodes: `flowNodes` is
   * the record of where things sit, and rewriting it on every selection would
   * risk losing a position mid-drag.
   */
  const renderedNodes = useMemo(() => {
    if (!highlight) return flowNodes;

    return flowNodes.map((node) => {
      if (node.id === highlightedNodeId)
        return { ...node, className: "tbx-node-picked" };
      return highlight.neighbours.has(node.id)
        ? node
        : { ...node, className: "tbx-node-muted" };
    });
  }, [flowNodes, highlight, highlightedNodeId]);

  const highlightedLabel = useMemo(
    () =>
      highlightedNodeId
        ? (nodes.find((node) => node.id === highlightedNodeId)?.label ??
          highlightedNodeId)
        : "",
    [highlightedNodeId, nodes],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<DependencyFlowNode>>(
    (_event, node) => {
      onNodeClick?.(node.data.dependencyNode);
    },
    [onNodeClick],
  );

  const fitViewOptions = useMemo<FitViewOptions>(
    () => ({ padding: 0.15, minZoom: fitViewMinZoom, maxZoom: 1 }),
    [fitViewMinZoom],
  );

  // React Flow only honours `fitView` on mount. Filtering or expanding the node
  // set afterwards would otherwise leave the viewport on the old bounds, which
  // can push every remaining node off screen.
  const fitSignature = useMemo(
    () => layoutedNodes.map((node) => node.id).join("|"),
    [layoutedNodes],
  );

  if (!hasRenderableDependencies) {
    return (
      <div
        className={cn(
          "flex h-[32rem] w-full items-center justify-center rounded-lg border border-dashed bg-card p-8 text-center text-card-foreground",
          className,
        )}
      >
        {emptyState ?? (
          <div className="max-w-sm space-y-2">
            <p className="text-sm font-medium">No dependencies to display</p>
            <p className="text-sm text-muted-foreground">
              Add related nodes and edges to render an interactive dependency
              graph.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div
        className={cn(
          "tbx-dependency-graph h-[32rem] w-full overflow-hidden rounded-lg border bg-background",
          className,
        )}
      >
        <ReactFlow
          nodes={renderedNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onNodesChange={handleNodesChange}
          onPaneClick={onPaneClick}
          fitView={fitView}
          fitViewOptions={fitViewOptions}
          // The instance floor would otherwise clamp fitView back up and cut
          // large graphs off at the edges.
          minZoom={Math.min(0.1, fitViewMinZoom)}
          maxZoom={1.5}
          nodesDraggable={nodesDraggable}
          nodesConnectable={false}
          elementsSelectable={Boolean(onNodeClick)}
          onMove={handleMove}
        >
          {fitView ? (
            <FitViewOnChange
              options={fitViewOptions}
              signature={fitSignature}
            />
          ) : null}
          <KeepSelectionInView
            fitViewOptions={fitViewOptions}
            nodeId={highlightedNodeId ?? null}
            viewportMoved={viewportMoved}
          />
          {nodesDraggable && hasCustomLayout ? (
            <Panel position="top-right">
              <ResetLayoutButton
                fitViewOptions={fitViewOptions}
                onReset={resetLayout}
                refit={fitView}
              />
            </Panel>
          ) : null}
          {highlight && onPaneClick ? (
            <Panel position="top-left">
              <ConnectionLegend
                hasIncoming={highlight.incoming > 0}
                hasOutgoing={highlight.outgoing > 0}
                label={highlightedLabel}
                onClear={onPaneClick}
              />
            </Panel>
          ) : null}
          <Background className="bg-background" gap={24} />
          <Controls showInteractive={false} />
          {(showMiniMap ?? nodes.length > 20) ? (
            <MiniMap
              pannable
              zoomable
              nodeColor={getMiniMapNodeColor}
              maskColor="hsl(var(--background) / 0.72)"
            />
          ) : null}
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

/**
 * Overlays stored positions onto the computed layout. Nodes without an entry
 * keep their computed spot, so a layout saved before a re-import still places
 * the nodes it knows about.
 */
function applyStoredPositions(
  layouted: Array<DependencyFlowNode>,
  stored: Readonly<Record<string, { x: number; y: number }>> | undefined,
): Array<DependencyFlowNode> {
  if (!stored || Object.keys(stored).length === 0) return layouted;

  return layouted.map((node) => {
    const position = stored[node.id];
    return position ? { ...node, position } : node;
  });
}

function collectPositions(
  flowNodes: Array<DependencyFlowNode>,
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of flowNodes) {
    positions[node.id] = { x: node.position.x, y: node.position.y };
  }
  return positions;
}

/** Order-independent so two equal layouts always produce the same string. */
function serializePositions(
  positions: Readonly<Record<string, { x: number; y: number }>> | undefined,
): string {
  if (!positions) return "";

  return Object.keys(positions)
    .sort()
    .map((key) => {
      const position = positions[key];
      return `${key}:${position?.x},${position?.y}`;
    })
    .join("|");
}

function FitViewOnChange({
  signature,
  options,
}: {
  signature: string;
  options: FitViewOptions;
}) {
  const { fitView } = useReactFlow();
  const fittedSignature = useRef<string | null>(null);

  useEffect(() => {
    if (fittedSignature.current === signature) return;
    fittedSignature.current = signature;

    // Deferred by a frame so React Flow has committed the new node set; its
    // bounds come from the dimensions we pass in, so no measurement is needed.
    const frame = requestAnimationFrame(() => {
      void fitView(options);
    });

    return () => cancelAnimationFrame(frame);
  }, [signature, fitView, options]);

  return null;
}

function ModuleNode(props: NodeProps<DependencyFlowNode>) {
  return (
    <GraphNodeFrame
      direction={props.data.layoutDirection}
      frameClassName="border-primary bg-primary text-primary-foreground shadow-md"
      kindLabel={kindLabels.module}
      node={props.data.dependencyNode}
      titleClassName="text-primary-foreground"
    />
  );
}

function ResourceNode(props: NodeProps<DependencyFlowNode>) {
  return (
    <GraphNodeFrame
      direction={props.data.layoutDirection}
      frameClassName="border-border bg-card text-card-foreground"
      kindLabel={kindLabels.resource}
      node={props.data.dependencyNode}
    />
  );
}

function DataSourceNode(props: NodeProps<DependencyFlowNode>) {
  return (
    <GraphNodeFrame
      direction={props.data.layoutDirection}
      // Same fill as a resource; only the dashed border sets it apart.
      frameClassName="border-dashed border-muted-foreground/50 bg-card text-card-foreground"
      kindLabel={kindLabels.data}
      node={props.data.dependencyNode}
    />
  );
}

function ExternalModuleNode(props: NodeProps<DependencyFlowNode>) {
  return (
    <GraphNodeFrame
      direction={props.data.layoutDirection}
      frameClassName="border-secondary bg-secondary text-secondary-foreground shadow-sm"
      kindLabel={kindLabels["external-module"]}
      node={props.data.dependencyNode}
    />
  );
}

function GraphNodeFrame({
  node,
  direction,
  kindLabel,
  frameClassName,
  titleClassName,
}: GraphNodeFrameProps) {
  const handlePositions = getHandlePositions(direction);
  const metadataEntries = Object.entries(node.metadata ?? {}).filter(
    (
      entry,
    ): entry is [
      string,
      Exclude<DependencyGraphMetadataValue, null | undefined>,
    ] => entry[1] !== null && entry[1] !== undefined,
  );
  const visibleMetadata = metadataEntries.slice(0, 2);

  return (
    <div
      className={cn(
        // `gap` rather than `justify-between`: when the content is taller than
        // the node, rows must clip at the bottom instead of overlapping.
        "relative flex h-full w-full flex-col gap-2 overflow-hidden rounded-lg border px-4 py-3 text-sm shadow-sm transition-shadow hover:shadow-md",
        frameClassName,
      )}
    >
      <Handle
        className="!h-2 !w-2 !border-background !bg-muted-foreground"
        isConnectable={false}
        position={handlePositions.target}
        type="target"
      />
      <div className="shrink-0 space-y-2 overflow-hidden">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full border border-current/20 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide opacity-80">
            {node.group ?? kindLabel}
          </span>
          {node.kind === "data" ? (
            <span className="text-[0.65rem] font-medium text-muted-foreground">
              read-only
            </span>
          ) : null}
        </div>
        <div className="space-y-1">
          <p
            className={cn("truncate font-semibold", titleClassName)}
            title={node.label}
          >
            {node.label}
          </p>
          {node.description ? (
            <p
              className="line-clamp-2 text-xs opacity-75"
              title={node.description}
            >
              {node.description}
            </p>
          ) : null}
        </div>
      </div>
      {visibleMetadata.length > 0 ? (
        <dl className="mt-auto flex shrink-0 gap-2 overflow-hidden text-[0.7rem] opacity-75">
          {visibleMetadata.map(([key, value]) => (
            <div
              className="min-w-0 truncate"
              key={key}
              title={`${key}: ${value}`}
            >
              <dt className="inline font-medium">{key}</dt>
              <dd className="inline">: {String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Handle
        className="!h-2 !w-2 !border-background !bg-muted-foreground"
        isConnectable={false}
        position={handlePositions.source}
        type="source"
      />
    </div>
  );
}

function getHandlePositions(direction: DependencyGraphLayoutDirection) {
  switch (direction) {
    case "BT":
      return { source: Position.Top, target: Position.Bottom };
    case "TB":
      return { source: Position.Bottom, target: Position.Top };
    case "RL":
      return { source: Position.Left, target: Position.Right };
    case "LR":
      return { source: Position.Right, target: Position.Left };
  }
}

function getMiniMapNodeColor(node: Node) {
  switch (node.type) {
    case "module":
      return "hsl(var(--primary))";
    case "external-module":
      return "hsl(var(--secondary))";
    default:
      return "hsl(var(--card))";
  }
}

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}
